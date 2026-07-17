import { useId, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type CatalogAuthorityButtonProps = ComponentProps<typeof Button> & {
  unavailableReason?: string;
};

export function CatalogAuthorityButton({
  unavailableReason,
  className,
  disabled,
  onClick,
  title,
  "aria-describedby": ariaDescribedBy,
  "aria-disabled": ariaDisabled,
  ...props
}: CatalogAuthorityButtonProps) {
  const reasonId = useId();
  const unavailable = Boolean(unavailableReason);
  const control = (
    <Button
      {...props}
      className={cn(className, unavailable && "cursor-not-allowed opacity-50")}
      disabled={unavailable ? false : disabled}
      aria-disabled={unavailable ? true : ariaDisabled}
      aria-describedby={
        unavailable ? [ariaDescribedBy, reasonId].filter(Boolean).join(" ") : ariaDescribedBy
      }
      title={unavailable ? unavailableReason : title}
      onClick={
        unavailable
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
            }
          : onClick
      }
    />
  );

  if (!unavailable) return control;

  return (
    <>
      <Tooltip>
        <TooltipTrigger render={control} />
        <TooltipContent>{unavailableReason}</TooltipContent>
      </Tooltip>
      <span id={reasonId} className="sr-only">
        {unavailableReason}
      </span>
    </>
  );
}
