import { type ReactNode, useId } from "react";

/** The Mars mark, filled with the brand gradient. */
export function OmpMark({ size = 22 }: { size?: number }): ReactNode {
	const gradient = `mars-mark-${useId().replace(/:/g, "")}`;
	return (
		<svg className="sh-mark" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
			<defs>
				<linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
					<stop offset="0" style={{ stopColor: "var(--mark-a)" }} />
					<stop offset=".5" style={{ stopColor: "var(--mark-b)" }} />
					<stop offset="1" style={{ stopColor: "var(--mark-c)" }} />
				</linearGradient>
			</defs>
			<path fill={`url(#${gradient})`} d="M12 14h8l12 18 12-18h8v36h-8V26l-12 18-12-18v24h-8z" />
		</svg>
	);
}

export { OmpMark as MarsMark };
