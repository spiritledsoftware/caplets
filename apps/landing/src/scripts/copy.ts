const copyButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-copy-value]"));
const copyStatus = document.querySelector<HTMLElement>("[data-copy-status]");

function setCopyFeedback(button: HTMLButtonElement, label: string, timeout = 1600) {
  const copyLabel = button.dataset.copyLabel ?? "value";
  button.setAttribute("data-copied", "true");
  button.setAttribute("aria-live", "polite");
  if (copyStatus) copyStatus.textContent = `${label}: ${copyLabel}.`;

  window.setTimeout(() => {
    button.removeAttribute("data-copied");
    button.removeAttribute("aria-live");
  }, timeout);
}

async function copyValue(button: HTMLButtonElement) {
  const value = button.dataset.copyValue;
  if (!value) return;

  if (!navigator.clipboard?.writeText) {
    setCopyFeedback(button, "Copy unavailable", 2200);
    return;
  }

  try {
    await navigator.clipboard.writeText(value);
    setCopyFeedback(button, "Copied");
  } catch {
    setCopyFeedback(button, "Copy unavailable", 2200);
  }
}

for (const button of copyButtons) {
  button.addEventListener("click", () => void copyValue(button));
}
