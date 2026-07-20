import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "../lib/utils";

type TooltipIconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tooltip: string;
};

export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ tooltip, className, children, ...rest }, ref) => (
    <button
      ref={ref}
      type="button"
      title={tooltip}
      aria-label={tooltip}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  ),
);
TooltipIconButton.displayName = "TooltipIconButton";
