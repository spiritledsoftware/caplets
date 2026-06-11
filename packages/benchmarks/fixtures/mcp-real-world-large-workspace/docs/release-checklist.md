# Checkout Release Checklist

## Required checks

- Confirm the rollback owner is assigned in the runbook.
- Confirm enabled checkout flags have reached the safe rollout threshold.
- Confirm the checkout status page renders the status panel.
- Confirm local source still routes retry budget changes through the release risk classifier.

## Current notes

The retry budget rollout remains below the safe threshold. Keep the release on hold until the rollout or rollback plan changes.
