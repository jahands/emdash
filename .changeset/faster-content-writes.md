---
"emdash": patch
---

Speeds up saving, autosaving, publishing, creating and trashing content. These requests now make far fewer sequential database round trips (an autosave drops from about 50 to about 12), which matters most on remote databases such as Hyperdrive and D1.

Media usage tracking for the written entry now updates just after the response is sent instead of before it. The work is still recorded with the write, so the media library's "used in" information catches up within moments, and the usage maintenance step still processes anything that was not finished.
