---
"emdash": patch
---

Updates the admin sign-in page so a signed-out visitor sees the sign-in card straight away. The page now includes the sign-in options the card needs, so the admin no longer requests them from `/_emdash/api/auth/mode` after it loads. That endpoint is unchanged.
