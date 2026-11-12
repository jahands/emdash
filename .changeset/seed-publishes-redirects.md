---
"emdash": patch
---

Fixes the first public request after site setup repairing the redirect rules with several database writes. Applying a seed, including the one the setup wizard applies, now publishes the redirect rules even when the seed defines no redirects.
