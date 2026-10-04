# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub's
[private vulnerability reporting](https://github.com/Orlando80/boxoffice/security/advisories/new)
(Security tab → "Report a vulnerability"). You should get an acknowledgement
within 5 working days.

## Scope

Boxoffice is a portfolio project and is not run in production for real venues.
Reports are still welcome, particularly on:

- reservation race conditions (oversells, double-spends of a hold)
- payment webhook handling (signature verification, idempotency)
- personal-data exposure (logs, exports, fixtures)
- leaked credentials anywhere in the repository or its history

## Handling payment data

Card data never enters this codebase: payments use Stripe in test mode with
tokens only. If you find a real card number, real personal data or a live
secret anywhere in the repo, report it as above and it will be removed and
rotated.
