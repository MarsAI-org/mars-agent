//! The deliberately small git-CLI escape hatch.
//!
//! Three categories are allowed to spawn `git`, per the hybrid policy:
//! - **Credential-bound network transfers** — clone/fetch/push must reuse the
//!   user's ssh config and credential helpers, which are subprocess-based by
//!   design; no library reaches auth parity (and gitoxide has no send-pack).
//! - **Reftable ref access** — no in-process reftable implementation exists.
//! - **Whole-worktree status/untracked walks** — a subprocess contains gitoxide
//!   worker-thread spawn failures under host resource exhaustion.
//!
//! The runner ports the hardened subprocess contract of the TS wrapper:
//! non-interactive env (`GIT_TERMINAL_PROMPT=0`, askpass rejection, `LC_ALL`
//! handling), `--no-optional-locks` for reads, fsmonitor/untracked-cache
//! disabled for writes, ambient `GIT_DIR`-family vars stripped, bounded output
//! capture, and deadline + SIGTERM→SIGKILL termination via tokio.

use std::{path::Path, process::Stdio, time::Duration};

use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use super::GitRepo;
use crate::{
	error::{Error, Result},
	types::{CloneOptions, PushOptions},
};

/// Default deadline for local git plumbing via the fallback runner.
pub const COMMAND_TIMEOUT: Duration = Duration::from_mins(5);
/// Default deadline for network transfers (`clone`/`fetch`/`push`); large-repo
/// transfers legitimately outlive [`COMMAND_TIMEOUT`].
pub const NETWORK_TIMEOUT: Duration = Duration::from_mins(30);
/// Deadline for synchronous plumbing on render paths (reftable HEAD reads):
/// a stalled invocation degrades instead of freezing the UI.
pub const SYNC_TIMEOUT: Duration = Duration::from_secs(5);
/// Maximum captured bytes per stream before truncation.
pub const OUTPUT_LIMIT_BYTES: usize = 8 * 1024 * 1024;

const TERMINATE_GRACE: Duration = Duration::from_secs(5);
const TRUNCATION_MARKER: &str = "\n[git subprocess output truncated at the capture limit]\n";

/// Captured result of a completed git invocation.
#[derive(Debug, Clone)]
pub(crate) struct CliOutput {
	/// Process exit code (`124` designates a deadline kill).
	pub exit_code: i32,
	/// Captured stdout, possibly truncated.
	pub stdout:    String,
	/// Captured stderr, possibly truncated.
	pub stderr:    String,
}

impl CliOutput {
	/// Convert a non-zero exit into [`Error::Cli`].
	pub fn into_checked(self, args: &[String]) -> Result<Self> {
		if self.exit_code == 0 {
			return Ok(self);
		}
		Err(Error::Cli {
			command:   format!("git {}", args.join(" ")),
			exit_code: self.exit_code,
			stdout:    self.stdout,
			stderr:    self.stderr,
		})
	}
}

/// Options for one fallback invocation.
#[derive(Debug, Default)]
pub(crate) struct RunOptions {
	/// Prefix `--no-optional-locks` instead of pinning fsmonitor/untracked-cache
	/// off.
	pub read_only: bool,
	/// Deadline; [`COMMAND_TIMEOUT`] when unset.
	pub timeout:   Option<Duration>,
	/// Bytes piped to stdin (commit messages, `update-ref --stdin` scripts).
	pub stdin:     Option<Vec<u8>>,
	/// Cooperative cancellation: the child is terminated when triggered.
	pub cancel:    Option<CancellationToken>,
}

/// Build the hardened argv prefix.
///
/// Reads get `--no-optional-locks`, which already keeps them from rewriting
/// the index, so they keep the repository's fsmonitor and untracked cache: a
/// whole-worktree status on a large repo polled by every open session is far
/// cheaper with both. Writes pin both off so a transient subprocess never
/// mutates fsmonitor/untracked-cache state in the index.
fn hardened_args(args: &[String], read_only: bool) -> Vec<String> {
	let mut out = Vec::with_capacity(args.len() + 4);
	if read_only {
		if !args.iter().any(|arg| arg == "--no-optional-locks") {
			out.push("--no-optional-locks".to_owned());
		}
	} else {
		for pin in ["core.fsmonitor=false", "core.untrackedCache=false"] {
			out.push("-c".to_owned());
			out.push(pin.to_owned());
		}
	}
	out.extend(args.iter().cloned());
	out
}

/// Environment sink for the two command builders. `std::process::Command` and
/// `tokio::process::Command` share no trait, and duplicating the contract per
/// builder is how the synchronous path silently lost the `LC_ALL` removal that
/// [`is_dubious_ownership`] depends on.
trait EnvSink {
	fn set(&mut self, key: &str, value: &str);
	fn unset(&mut self, key: &str);
}

impl EnvSink for std::process::Command {
	fn set(&mut self, key: &str, value: &str) {
		self.env(key, value);
	}

	fn unset(&mut self, key: &str) {
		self.env_remove(key);
	}
}

impl EnvSink for tokio::process::Command {
	fn set(&mut self, key: &str, value: &str) {
		self.env(key, value);
	}

	fn unset(&mut self, key: &str) {
		self.env_remove(key);
	}
}

/// Apply the non-interactive environment contract to a command builder:
/// prompts rejected, editors disabled, ambient repo-location and pathspec
/// overrides stripped, `LC_MESSAGES=C` for parseable errors while preserving a
/// UTF-8 character locale. `LC_ALL` must go: it outranks `LC_MESSAGES`, so
/// leaving it inherited would hand back localized diagnostics.
///
/// The `*_PATHSPECS` variables are global pathspec modes, so an inherited
/// `GIT_LITERAL_PATHSPECS=1` would make the `:(literal)` magic this crate
/// builds match a filename containing that prefix (i.e. nothing), and
/// `GIT_ICASE_PATHSPECS=1` would match case variants the caller did not ask
/// for. Explicit magic is only explicit once they are gone.
fn apply_env(cmd: &mut impl EnvSink) {
	for stripped in [
		"GIT_DIR",
		"GIT_COMMON_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_LITERAL_PATHSPECS",
		"GIT_GLOB_PATHSPECS",
		"GIT_NOGLOB_PATHSPECS",
		"GIT_ICASE_PATHSPECS",
	] {
		cmd.unset(stripped);
	}
	if let Some(lc_all) = std::env::var_os("LC_ALL") {
		let lc_all = lc_all.to_string_lossy().into_owned();
		if is_utf8_locale(&lc_all) {
			cmd.set("LC_CTYPE", &lc_all);
		}
	}
	cmd.unset("LC_ALL");
	cmd.set("LC_MESSAGES", "C");
	cmd.set("GIT_OPTIONAL_LOCKS", "0");
	cmd.set("GIT_ASKPASS", "true");
	cmd.set("GIT_EDITOR", "true");
	cmd.set("GIT_TERMINAL_PROMPT", "0");
	cmd.set("SSH_ASKPASS", "false");
}

/// Loose match for a UTF-8 character locale (`en_US.UTF-8`, `C.utf8`, …).
fn is_utf8_locale(value: &str) -> bool {
	let lower = value.to_ascii_lowercase();
	["utf-8", "utf8"].iter().any(|needle| {
		lower
			.split(['.', '_', '-', '@'])
			.any(|part| part == *needle)
			|| lower.ends_with(needle)
			|| lower.contains(&format!(".{needle}"))
	})
}

/// Run `git` asynchronously with bounded capture and a deadline.
/// Non-zero exits are returned in [`CliOutput`], not raised.
pub(crate) async fn run(cwd: &Path, args: &[String], options: &RunOptions) -> Result<CliOutput> {
	let argv = hardened_args(args, options.read_only);
	let mut cmd = tokio::process::Command::new("git");
	cmd.args(&argv)
		.current_dir(cwd)
		.stdin(if options.stdin.is_some() {
			Stdio::piped()
		} else {
			Stdio::null()
		})
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.kill_on_drop(true);
	apply_env(&mut cmd);
	let mut child = cmd.spawn().map_err(|err| spawn_error(cwd, err))?;

	let stdin_task = options.stdin.as_ref().and_then(|stdin| {
		let mut pipe = child.stdin.take()?;
		let payload = stdin.clone();
		Some(tokio::spawn(async move {
			use tokio::io::AsyncWriteExt;
			// A child that exits early (e.g. usage error) closes the pipe;
			// that is its answer, not ours to fail on.
			let _ = pipe.write_all(&payload).await;
			let _ = pipe.shutdown().await;
		}))
	});

	let stdout = child.stdout.take().expect("stdout piped");
	let stderr = child.stderr.take().expect("stderr piped");
	let stdout_task = tokio::spawn(read_capped(stdout));
	let stderr_task = tokio::spawn(read_capped(stderr));

	let timeout = options.timeout.unwrap_or(COMMAND_TIMEOUT);
	let cancel = options.cancel.clone().unwrap_or_default();
	let exit = tokio::select! {
		status = tokio::time::timeout(timeout, child.wait()) => match status {
			Ok(Ok(status)) => status,
			Ok(Err(err)) => {
				if let Some(task) = stdin_task {
					task.abort();
				}
				stdout_task.abort();
				stderr_task.abort();
				return Err(Error::Io(err));
			},
			Err(_elapsed) => {
				if let Some(task) = stdin_task {
					task.abort();
				}
				terminate(&mut child).await;
				stdout_task.abort();
				stderr_task.abort();
				return Err(Error::CliTimeout { command: format!("git {}", argv.join(" ")) });
			},
		},
		() = cancel.cancelled() => {
			if let Some(task) = stdin_task {
				task.abort();
			}
			terminate(&mut child).await;
			stdout_task.abort();
			stderr_task.abort();
			return Err(Error::Canceled);
		},
	};
	if let Some(task) = stdin_task {
		task.abort();
	}

	let stdout = stdout_task
		.await
		.map_err(|err| Error::backend("git run", err))??;
	let stderr = stderr_task
		.await
		.map_err(|err| Error::backend("git run", err))??;
	Ok(CliOutput { exit_code: exit.code().unwrap_or(-1), stdout, stderr })
}

/// Run `git` asynchronously and map a non-zero exit to [`Error::Cli`].
pub(crate) async fn run_checked(
	cwd: &Path,
	args: &[String],
	options: &RunOptions,
) -> Result<CliOutput> {
	run(cwd, args, options).await?.into_checked(args)
}

/// Whether `err` means the git binary could not be launched at all (missing
/// binary or deleted cwd), as opposed to git running and failing. Callers with
/// an in-process fallback (e.g. porcelain status) branch on this.
pub(crate) fn is_spawn_failure(err: &Error) -> bool {
	matches!(err, Error::Backend { context: "git spawn", .. })
}

/// Whether captured output hit [`OUTPUT_LIMIT_BYTES`] and therefore lost
/// bytes. Callers whose output is a value rather than a diagnostic (path
/// lists) must retry in-process or fail, never return the short result.
pub(crate) fn is_truncated(text: &str) -> bool {
	text.ends_with(TRUNCATION_MARKER)
}

/// Whether git refused the checkout under its `safe.directory` ownership
/// check (`fatal: detected dubious ownership`, exit 128), which happens
/// whenever the process user differs from the checkout owner — a
/// host-mounted repository inside a container is the common case.
///
/// `open::open_options` opens user-chosen checkouts with `Trust::Full` on
/// purpose, so the in-process walk has no such objection: a caller with a
/// gitoxide fallback must take it rather than surface an error the
/// library-backed path would never have produced.
///
/// [`apply_env`] pins `LC_MESSAGES=C` and drops the `LC_ALL` that would
/// outrank it, so the English wording is what git emits. `safe.directory` is
/// matched as well: it is a config key, so it survives translation even if a
/// host manages to localize the diagnostic anyway.
pub(crate) fn is_dubious_ownership(err: &Error) -> bool {
	matches!(
		err,
		Error::Cli { exit_code: 128, stderr, .. }
			if stderr.contains("dubious ownership") || stderr.contains("safe.directory")
	)
}

/// Whether `err` describes a CLI that could not do the work at all while the
/// in-process gitoxide path still can.
pub(crate) fn prefers_in_process(err: &Error) -> bool {
	is_spawn_failure(err) || is_dubious_ownership(err)
}

/// Synchronous bounded runner with a caller-chosen deadline; render paths pass
/// [`SYNC_TIMEOUT`] so a stalled git cannot freeze the UI. Stdout/stderr are
/// drained concurrently with capped retention, so output larger than the OS
/// pipe buffer can never stall the child into a spurious timeout.
pub(crate) fn run_sync(cwd: &Path, args: &[String], timeout: Duration) -> Result<CliOutput> {
	run_sync_capped(cwd, args, timeout, OUTPUT_LIMIT_BYTES)
}

/// [`run_sync`] with an explicit retention cap. The cap is a parameter rather
/// than a constant read inside the reader threads so a test can exercise the
/// truncation contract on one call without lowering the limit for every other
/// invocation in the process.
pub(crate) fn run_sync_capped(
	cwd: &Path,
	args: &[String],
	timeout: Duration,
	limit: usize,
) -> Result<CliOutput> {
	let argv = hardened_args(args, true);
	let mut cmd = std::process::Command::new("git");
	cmd.args(&argv)
		.current_dir(cwd)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped());
	apply_env(&mut cmd);
	let mut child = cmd.spawn().map_err(|err| spawn_error(cwd, err))?;
	let stdout = spawn_sync_reader("git-cli-stdout", child.stdout.take(), limit);
	let stderr = spawn_sync_reader("git-cli-stderr", child.stderr.take(), limit);

	let deadline = std::time::Instant::now() + timeout;
	let status = loop {
		match child.try_wait()? {
			Some(status) => break Some(status),
			None if std::time::Instant::now() >= deadline => {
				let _ = child.kill();
				let _ = child.wait();
				break None;
			},
			None => std::thread::sleep(Duration::from_millis(10)),
		}
	};
	// The child has exited (or been killed), so the pipes reach EOF and the
	// readers terminate; join can only block briefly on the final drain.
	let stdout = stdout.map_or_else(String::new, |h| h.join().unwrap_or_default());
	let stderr = stderr.map_or_else(String::new, |h| h.join().unwrap_or_default());
	let Some(status) = status else {
		return Err(Error::CliTimeout { command: format!("git {}", argv.join(" ")) });
	};
	Ok(CliOutput { exit_code: status.code().unwrap_or(-1), stdout, stderr })
}

/// Drain a child stream on a helper thread, mirroring [`read_capped`].
///
/// `None` when the stream is absent or the thread cannot be spawned (e.g.
/// under the same memory pressure that motivates the CLI path); dropping the
/// stream then closes the pipe, so a chatty child fails with EPIPE and
/// surfaces as a non-zero exit instead of a hang.
fn spawn_sync_reader(
	name: &'static str,
	stream: Option<impl std::io::Read + Send + 'static>,
	limit: usize,
) -> Option<std::thread::JoinHandle<String>> {
	let stream = stream?;
	std::thread::Builder::new()
		.name(name.into())
		.spawn(move || read_capped_sync(stream, limit))
		.ok()
}

/// Synchronous mirror of [`read_capped`]: cap retention at `limit` while
/// draining to EOF so the child never blocks.
fn read_capped_sync(mut stream: impl std::io::Read, limit: usize) -> String {
	let mut retained: Vec<u8> = Vec::new();
	let mut buf = [0u8; 8 * 1024];
	let mut truncated = false;
	loop {
		let n = match stream.read(&mut buf) {
			Ok(0) | Err(_) => break,
			Ok(n) => n,
		};
		if truncated {
			continue;
		}
		let remaining = limit - retained.len();
		if n <= remaining {
			retained.extend_from_slice(&buf[..n]);
		} else {
			retained.extend_from_slice(&buf[..remaining]);
			truncated = true;
		}
	}
	let mut text = String::from_utf8_lossy(&retained).into_owned();
	if truncated {
		text.push_str(TRUNCATION_MARKER);
	}
	text
}

fn spawn_error(cwd: &Path, err: std::io::Error) -> Error {
	if err.kind() == std::io::ErrorKind::NotFound {
		// A deleted cwd also surfaces as spawn ENOENT; only blame the binary
		// when the working directory actually exists.
		let message = if cwd.exists() {
			"git is not installed.".to_owned()
		} else {
			format!("working directory does not exist: {}", cwd.display())
		};
		return Error::backend("git spawn", message);
	}
	Error::Io(err)
}

/// Read a stream to completion, capping retention at [`OUTPUT_LIMIT_BYTES`]
/// while continuing to drain so the child never blocks on a full pipe.
async fn read_capped(mut stream: impl tokio::io::AsyncRead + Unpin) -> Result<String> {
	let mut retained: Vec<u8> = Vec::new();
	let mut buf = [0u8; 8 * 1024];
	let mut truncated = false;
	loop {
		let n = stream.read(&mut buf).await.map_err(Error::Io)?;
		if n == 0 {
			break;
		}
		if truncated {
			continue;
		}
		let remaining = OUTPUT_LIMIT_BYTES - retained.len();
		if n <= remaining {
			retained.extend_from_slice(&buf[..n]);
		} else {
			retained.extend_from_slice(&buf[..remaining]);
			truncated = true;
		}
	}
	let mut text = String::from_utf8_lossy(&retained).into_owned();
	if truncated {
		text.push_str(TRUNCATION_MARKER);
	}
	Ok(text)
}

/// SIGTERM, grace period, then SIGKILL.
async fn terminate(child: &mut tokio::process::Child) {
	#[cfg(unix)]
	if let Some(pid) = child.id() {
		// SAFETY: plain kill(2) on a pid we own; no memory is touched.
		unsafe {
			libc::kill(pid as i32, libc::SIGTERM);
		}
		if tokio::time::timeout(TERMINATE_GRACE, child.wait())
			.await
			.is_ok()
		{
			return;
		}
	}
	let _ = child.kill().await;
	let _ = tokio::time::timeout(TERMINATE_GRACE, child.wait()).await;
}

// ═══════════════════════════════════════════════════════════════════════════
// Network operations (public API)
// ═══════════════════════════════════════════════════════════════════════════

fn reject_leading_dash(context: &'static str, field: &str, value: &str) -> Result<()> {
	if value.starts_with('-') {
		return Err(Error::backend(context, format!("{field} must not start with '-': {value}")));
	}
	Ok(())
}

impl GitRepo {
	/// Push the current branch (branch-scoped: never follows tags).
	///
	/// `--no-follow-tags` overrides a user's `push.followTags = true`, which
	/// would otherwise ride every reachable annotated tag along with the
	/// branch — rejected refs on remotes the user cannot tag (e.g. PR-head
	/// forks) would fail the call after the branch itself already updated.
	pub async fn push(
		&self,
		options: &PushOptions,
		cancel: Option<CancellationToken>,
	) -> Result<()> {
		if let Some(remote) = &options.remote {
			reject_leading_dash("git push", "remote", remote)?;
		}
		if let Some(refspec) = &options.refspec {
			reject_leading_dash("git push", "refspec", refspec)?;
		}
		let mut args = vec!["push".to_owned(), "--no-follow-tags".to_owned()];
		if options.force_with_lease {
			args.push("--force-with-lease".to_owned());
		}
		if options.remote.is_some() || options.refspec.is_some() {
			args.push("--".to_owned());
		}
		if let Some(remote) = &options.remote {
			args.push(remote.clone());
		}
		if let Some(refspec) = &options.refspec {
			args.push(refspec.clone());
		}
		run_checked(self.root(), &args, &RunOptions {
			timeout: Some(NETWORK_TIMEOUT),
			cancel,
			..RunOptions::default()
		})
		.await?;
		Ok(())
	}

	/// Fetch `+source:target` from a remote.
	pub async fn fetch(
		&self,
		remote: &str,
		source: &str,
		target: &str,
		timeout: Option<Duration>,
		cancel: Option<CancellationToken>,
	) -> Result<()> {
		reject_leading_dash("git fetch", "remote", remote)?;
		let args = vec![
			"fetch".to_owned(),
			"--".to_owned(),
			remote.to_owned(),
			format!("+{source}:{target}"),
		];
		run_checked(self.root(), &args, &RunOptions {
			timeout: Some(timeout.unwrap_or(NETWORK_TIMEOUT)),
			cancel,
			..RunOptions::default()
		})
		.await?;
		Ok(())
	}
}

/// Clone `url` into `target_dir`, removing the partial clone on any failure
/// (only if `target_dir` did not already exist before the clone started).
///
/// Shallow (`--depth 1 --single-branch`) unless a specific SHA is pinned:
/// a shallow clone only fetches the tip, so checking out a non-tip commit
/// would fail with "reference is not a tree".
pub async fn clone(
	url: &str,
	target_dir: &Path,
	options: &CloneOptions,
	cancel: Option<CancellationToken>,
) -> Result<()> {
	reject_leading_dash("git clone", "url", url)?;
	if let Some(ref_name) = &options.ref_name {
		reject_leading_dash("git clone", "ref_name", ref_name)?;
	}
	if let Some(sha) = &options.sha {
		reject_leading_dash("git clone", "sha", sha)?;
	}

	let absolute = std::path::absolute(target_dir)?;
	let existed_before = tokio::fs::symlink_metadata(&absolute).await.is_ok();
	let parent = absolute
		.parent()
		.map_or_else(|| absolute.clone(), Path::to_owned);
	tokio::fs::create_dir_all(&parent).await?;

	let shallow = options.sha.is_none();
	let mut args = vec!["clone".to_owned()];
	if shallow {
		args.push("--depth".to_owned());
		args.push("1".to_owned());
	}
	if let Some(ref_name) = &options.ref_name {
		args.push("--branch".to_owned());
		args.push(ref_name.clone());
		args.push("--single-branch".to_owned());
	} else if shallow {
		args.push("--single-branch".to_owned());
	}
	args.push("--".to_owned());
	args.push(url.to_owned());
	args.push(absolute.to_string_lossy().into_owned());

	let run_options = RunOptions {
		timeout: Some(options.timeout.unwrap_or(NETWORK_TIMEOUT)),
		cancel: cancel.clone(),
		..RunOptions::default()
	};
	let outcome = run_checked(&parent, &args, &run_options).await;
	if let Err(err) = outcome {
		if !existed_before {
			let _ = tokio::fs::remove_dir_all(&absolute).await;
		}
		return Err(err);
	}

	if let Some(sha) = &options.sha {
		let checkout = run_checked(
			&absolute,
			&["checkout".to_owned(), sha.clone(), "--".to_owned()],
			&RunOptions { cancel, ..RunOptions::default() },
		)
		.await;
		if checkout.is_err() {
			if !existed_before {
				let _ = tokio::fs::remove_dir_all(&absolute).await;
			}
			return Err(Error::backend(
				"git clone",
				format!("failed to checkout SHA {sha} in cloned repository {url}"),
			));
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Set on the re-executed child; carries the fixture repository it should
	/// probe. Its presence is what tells the test body which side it is on.
	const ENV_PROBE_REPO: &str = "PI_VCS_TEST_ENV_PROBE_REPO";

	/// Asks git to report the ambient variables it was started with. A `!`-alias
	/// is the only way to make git print its own environment.
	const ENV_PROBE_ALIAS: &str = r#"!printf 'LC_ALL=[%s] LC_CTYPE=[%s] LC_MESSAGES=[%s] LITERAL=[%s] ICASE=[%s]' "$LC_ALL" "$LC_CTYPE" "$LC_MESSAGES" "$GIT_LITERAL_PATHSPECS" "$GIT_ICASE_PATHSPECS""#;

	/// Two guarantees this crate builds on top of, both of which depend on what
	/// the child process actually receives:
	///
	/// - The ownership fallback reads git's diagnostic, and `LC_ALL` outranks
	///   `LC_MESSAGES`, so an inherited one hands back a translated message that
	///   [`is_dubious_ownership`] cannot match.
	/// - The `:(literal)` magic this crate builds is only explicit once the
	///   global pathspec modes are gone; `GIT_LITERAL_PATHSPECS=1` would turn
	///   the prefix into filename text and match nothing.
	///
	/// Asserted through [`run_sync`] rather than [`apply_env`] directly, because
	/// the regression this covers was the synchronous builder not calling the
	/// helper. The variables have to be present before the process starts, and
	/// `set_var` in a running test binary is observable by every other thread,
	/// so the probe runs in a re-executed copy of this test binary spawned with
	/// them already in its environment.
	#[test]
	fn sync_runner_pins_message_locale_and_scrubs_pathspec_modes() {
		if let Some(repo) = std::env::var_os(ENV_PROBE_REPO) {
			let out = run_sync(
				Path::new(&repo),
				&["-c".to_owned(), format!("alias.envprobe={ENV_PROBE_ALIAS}"), "envprobe".to_owned()],
				SYNC_TIMEOUT,
			)
			.expect("run alias");

			assert_eq!(out.exit_code, 0, "alias failed: {out:?}");
			assert!(out.stdout.contains("LC_ALL=[]"), "LC_ALL leaked: {out:?}");
			assert!(out.stdout.contains("LC_MESSAGES=[C]"), "messages not pinned: {out:?}");
			// The character locale is preserved so paths keep round-tripping as
			// UTF-8; only the message locale is forced.
			assert!(
				out.stdout.contains("LC_CTYPE=[fr_FR.UTF-8]"),
				"UTF-8 character locale dropped: {out:?}"
			);
			assert!(out.stdout.contains("LITERAL=[]"), "literal pathspec mode leaked: {out:?}");
			assert!(out.stdout.contains("ICASE=[]"), "icase pathspec mode leaked: {out:?}");
			return;
		}

		let dir = tempfile::tempdir().expect("tempdir");
		let init = std::process::Command::new("git")
			.args(["init", "-q", "-b", "main"])
			.current_dir(dir.path())
			.status()
			.expect("spawn git init");
		assert!(init.success(), "git init failed");

		let name = format!(
			"{}::sync_runner_pins_message_locale_and_scrubs_pathspec_modes",
			module_path!()
				.split_once("::")
				.expect("crate-qualified module path")
				.1
		);
		let child = std::process::Command::new(std::env::current_exe().expect("test binary"))
			.args(["--exact", &name, "--nocapture", "--test-threads=1"])
			.env(ENV_PROBE_REPO, dir.path())
			.env("LC_ALL", "fr_FR.UTF-8")
			.env("GIT_LITERAL_PATHSPECS", "1")
			.env("GIT_ICASE_PATHSPECS", "1")
			.output()
			.expect("re-exec test binary");
		assert!(
			child.status.success(),
			"environment probe failed:\n{}{}",
			String::from_utf8_lossy(&child.stdout),
			String::from_utf8_lossy(&child.stderr)
		);
	}

	#[tokio::test]
	async fn rejects_leading_dash_arguments_and_preserves_existing_clone_target() {
		let dir = tempfile::tempdir().expect("tempdir");
		let init = std::process::Command::new("git")
			.args(["init", "-q", "-b", "main"])
			.current_dir(dir.path())
			.status()
			.expect("spawn git init");
		assert!(init.success(), "git init failed");

		let repo = GitRepo::require(dir.path()).expect("open repo");

		let push_remote = repo
			.push(
				&PushOptions {
					remote:           Some("--upload-pack=evil".to_owned()),
					refspec:          None,
					force_with_lease: false,
				},
				None,
			)
			.await;
		assert!(push_remote.is_err(), "leading-dash remote must be rejected");

		let push_refspec = repo
			.push(
				&PushOptions {
					remote:           Some("origin".to_owned()),
					refspec:          Some("--delete".to_owned()),
					force_with_lease: false,
				},
				None,
			)
			.await;
		assert!(push_refspec.is_err(), "leading-dash refspec must be rejected");

		let fetch_remote = repo
			.fetch("--upload-pack=evil", "main", "refs/remotes/origin/main", None, None)
			.await;
		assert!(fetch_remote.is_err(), "leading-dash fetch remote must be rejected");

		let target = dir.path().join("fresh-clone");
		assert!(
			clone("--upload-pack=evil", &target, &CloneOptions::default(), None)
				.await
				.is_err(),
			"leading-dash clone url must be rejected"
		);
		assert!(
			clone(
				"https://example.invalid/repo.git",
				&target,
				&CloneOptions { ref_name: Some("--evil".to_owned()), ..CloneOptions::default() },
				None,
			)
			.await
			.is_err(),
			"leading-dash ref_name must be rejected"
		);
		assert!(
			clone(
				"https://example.invalid/repo.git",
				&target,
				&CloneOptions { sha: Some("--force".to_owned()), ..CloneOptions::default() },
				None,
			)
			.await
			.is_err(),
			"leading-dash sha must be rejected"
		);

		// A failed clone against an existing directory must NOT delete it.
		let existing = dir.path().join("existing-target");
		std::fs::create_dir_all(&existing).expect("create existing dir");
		let sentinel = existing.join("keep.txt");
		std::fs::write(&sentinel, b"important").expect("write sentinel");
		let failed = clone(
			&dir.path().join("does-not-exist.git").to_string_lossy(),
			&existing,
			&CloneOptions::default(),
			None,
		)
		.await;
		assert!(failed.is_err(), "clone from nonexistent path should fail");
		assert!(sentinel.exists(), "existing target_dir must survive failed clone");
	}

	#[tokio::test]
	async fn large_stdin_with_concurrent_stdout_does_not_deadlock() {
		let dir = tempfile::tempdir().expect("tempdir");
		let init = std::process::Command::new("git")
			.args(["init", "-q", "-b", "main"])
			.current_dir(dir.path())
			.status()
			.expect("spawn git init");
		assert!(init.success(), "git init failed");

		// Exceed OS pipe buffers (typically 64 KiB on Linux) on both stdin and
		// stdout simultaneously; sequential stdin writes before spawning
		// stdout_task deadlock here.
		let payload = "0123456789abcdef\n".repeat(32 * 1024);
		let out = run(
			dir.path(),
			&["-c".to_owned(), "alias.echo=!cat".to_owned(), "echo".to_owned()],
			&RunOptions {
				read_only: true,
				timeout:   Some(Duration::from_secs(10)),
				stdin:     Some(payload.as_bytes().to_vec()),
				cancel:    None,
			},
		)
		.await
		.expect("concurrent stdin/stdout must not deadlock");
		assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
		assert_eq!(out.stdout, payload);
	}

	#[tokio::test]
	async fn timeout_and_cancel_interrupt_blocked_stdin_write() {
		let dir = tempfile::tempdir().expect("tempdir");
		let init = std::process::Command::new("git")
			.args(["init", "-q", "-b", "main"])
			.current_dir(dir.path())
			.status()
			.expect("spawn git init");
		assert!(init.success(), "git init failed");

		// Larger than OS pipe buffer so stdin writing blocks when the child does
		// not read stdin.
		let large_stdin = vec![b'x'; 512 * 1024];
		let args = vec!["-c".to_owned(), "alias.stall=!exec sleep 30".to_owned(), "stall".to_owned()];

		let timed_out = run(dir.path(), &args, &RunOptions {
			read_only: true,
			timeout:   Some(Duration::from_millis(150)),
			stdin:     Some(large_stdin.clone()),
			cancel:    None,
		})
		.await;
		assert!(
			matches!(timed_out, Err(Error::CliTimeout { .. })),
			"expected CliTimeout when child blocks stdin write, got: {timed_out:?}"
		);

		let cancel = CancellationToken::new();
		let cancel_trigger = cancel.clone();
		tokio::spawn(async move {
			tokio::time::sleep(Duration::from_millis(100)).await;
			cancel_trigger.cancel();
		});
		let canceled = run(dir.path(), &args, &RunOptions {
			read_only: true,
			timeout:   Some(Duration::from_secs(30)),
			stdin:     Some(large_stdin),
			cancel:    Some(cancel),
		})
		.await;
		assert!(
			matches!(canceled, Err(Error::Canceled)),
			"expected Canceled when token fires during blocked stdin write, got: {canceled:?}"
		);
	}
}
