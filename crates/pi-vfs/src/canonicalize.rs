//! uucore-compatible canonicalization over any backend, URL-aware.
//!
//! Mirrors `uucore::fs::canonicalize`: the same missing-component and
//! symlink-resolution modes, trailing-slash directory checks, and loop
//! detection, but `scheme://` is a root that `..` never climbs above, and
//! every lookup goes through a [`Resolver`] instead of the host.

use std::{
	collections::{HashSet, VecDeque},
	future::Future,
	io,
	path::{MAIN_SEPARATOR, Path, PathBuf},
};

use crate::{
	error::symlink_loop,
	options::{CanonicalizeOptions, MissingHandling, ResolveMode},
	path::{Part, PathBuilder, normalize_lexically, parent_path, parts},
};

/// Symlinks followed before loop detection starts (uucore's threshold).
const SYMLINKS_BEFORE_LOOP_CHECK: usize = 20;
/// Hard cap on total symlink expansions (matches Linux `MAXSYMLINKS` = 40),
/// bounding growing cycles such as `a -> a/a` whose remaining path changes on
/// every iteration and would otherwise evade the `(dir, remaining)` visited
/// set.
const MAX_SYMLINK_EXPANSIONS: usize = 40;

/// Filesystem lookups needed by [`canonicalize`].
pub(crate) trait Resolver: Sync {
	/// `Some(target)` when `path` itself is a symbolic link.
	fn symlink_target(
		&self,
		path: &Path,
	) -> impl Future<Output = io::Result<Option<PathBuf>>> + Send;

	/// `path` exists (following symlinks).
	fn exists(&self, path: &Path) -> impl Future<Output = bool> + Send;

	/// `path` is an existing directory; `ENOTDIR`/`ENOENT`/... otherwise.
	fn require_dir(&self, path: &Path) -> impl Future<Output = io::Result<()>> + Send;
}

fn ends_with_separator(path: &Path) -> bool {
	let bytes = path.as_os_str().as_encoded_bytes();
	bytes.ends_with(b"/") || bytes.ends_with(MAIN_SEPARATOR.encode_utf8(&mut [0; 4]).as_bytes())
}

fn remaining_path(parts: &VecDeque<Part>) -> PathBuf {
	let mut out = PathBuf::new();
	for part in parts {
		match part {
			Part::Root(root) => out.push(root),
			Part::Cur => out.push("."),
			Part::Parent => out.push(".."),
			Part::Normal(name) => out.push(name),
		}
	}
	out
}

/// Canonicalizes an absolute (host or URL) path.
///
/// Relative host paths are made absolute by the resolver's caller; a
/// relative path reaching here is resolved relative to nothing (left
/// relative), which only providers can give meaning to.
pub(crate) async fn canonicalize<R: Resolver>(
	resolver: &R,
	original: &Path,
	options: &CanonicalizeOptions,
) -> io::Result<PathBuf> {
	let has_to_be_directory =
		matches!(options.missing, MissingHandling::Normal | MissingHandling::Existing)
			&& ends_with_separator(original);
	let logical;
	let path = if options.resolve == ResolveMode::Logical {
		logical = normalize_lexically(original);
		logical.as_path()
	} else {
		original
	};

	let mut pending: VecDeque<Part> = parts(path).into();
	let mut result = PathBuilder::default();
	let mut followed = 0usize;
	let mut visited: HashSet<(PathBuf, PathBuf)> = HashSet::new();

	while let Some(part) = pending.pop_front() {
		match part {
			Part::Root(root) => {
				result.set_root(root);
				continue;
			},
			Part::Cur => continue,
			Part::Parent => {
				result.pop();
				continue;
			},
			Part::Normal(name) => result.push(name),
		}
		if options.resolve == ResolveMode::None {
			continue;
		}
		let current = result.to_path();
		match resolver.symlink_target(&current).await {
			Ok(Some(target)) => {
				followed += 1;
				if followed > MAX_SYMLINK_EXPANSIONS {
					return Err(symlink_loop());
				}
				for part in parts(&target).into_iter().rev() {
					pending.push_front(part);
				}
				if followed > SYMLINKS_BEFORE_LOOP_CHECK {
					let dir = parent_path(&current).map_or_default(Path::to_path_buf);
					if !visited.insert((dir, remaining_path(&pending))) {
						return Err(symlink_loop());
					}
				}
				result.pop();
			},
			Ok(None) => {},
			Err(err) => {
				if options.missing == MissingHandling::Existing
					|| (options.missing == MissingHandling::Normal && !pending.is_empty())
				{
					return Err(err);
				}
			},
		}
	}

	let result = result.to_path();
	match options.missing {
		MissingHandling::Existing => {
			if has_to_be_directory {
				resolver.require_dir(&result).await?;
			}
		},
		MissingHandling::Normal => {
			if resolver.exists(&result).await {
				if has_to_be_directory {
					resolver.require_dir(&result).await?;
				}
			} else if let Some(parent) = parent_path(&result) {
				resolver.require_dir(parent).await?;
			}
		},
		MissingHandling::Missing => {},
	}
	Ok(result)
}

#[cfg(test)]
mod tests {
	use super::*;

	struct GrowingCycleResolver;

	impl Resolver for GrowingCycleResolver {
		fn symlink_target(
			&self,
			path: &Path,
		) -> impl Future<Output = io::Result<Option<PathBuf>>> + Send {
			let result = if path.file_name().is_some_and(|name| name == "a") {
				Ok(Some(PathBuf::from("a/a")))
			} else {
				Ok(None)
			};
			std::future::ready(result)
		}

		fn exists(&self, _path: &Path) -> impl Future<Output = bool> + Send {
			std::future::ready(true)
		}

		fn require_dir(&self, _path: &Path) -> impl Future<Output = io::Result<()>> + Send {
			std::future::ready(Ok(()))
		}
	}

	#[test]
	fn growing_symlink_cycle_hits_expansion_cap() {
		let runtime = tokio::runtime::Builder::new_current_thread()
			.build()
			.expect("runtime");
		let options = CanonicalizeOptions::new(MissingHandling::Missing, ResolveMode::Physical);
		let err = runtime
			.block_on(canonicalize(&GrowingCycleResolver, Path::new("/root/a"), &options))
			.expect_err("growing symlink cycle must fail");
		assert_eq!(err.to_string(), "Too many levels of symbolic links");
	}
}
