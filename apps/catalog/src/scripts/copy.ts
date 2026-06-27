const copyStatus = document.querySelector("[data-copy-status]") as HTMLElement | null;

function announceCopyStatus(message: string): void {
  if (!copyStatus) return;
  copyStatus.textContent = "";
  window.setTimeout(() => {
    copyStatus.textContent = message;
  }, 0);
}

async function copyCommand(button: HTMLButtonElement): Promise<void> {
  const command = button.dataset.copyCommand ?? "";
  try {
    await navigator.clipboard.writeText(command);
    announceCopyStatus("Install command copied.");
  } catch {
    announceCopyStatus("Copy failed. Select the command text manually.");
  }
}

document.addEventListener("click", (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
    "[data-copy-command]",
  );
  if (!button) return;
  void copyCommand(button);
});

export {};
