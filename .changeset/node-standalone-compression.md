---
"emdash": minor
---

Adds response compression to sites that use `@astrojs/node` in standalone mode. Browsers that send `Accept-Encoding` receive Brotli or gzip, so an admin screen transfers about a quarter of the bytes it did before.

`astro build` now writes `.br` and `.gz` copies of the JavaScript, CSS and other text assets in `dist/client/_astro/`, and the server sends the copy the browser accepts. Pages, API responses and other text responses are compressed as they are sent. Images, already-encoded responses, responses under 1 KiB, event streams and range requests are sent unchanged, and compressible responses carry `Vary: Accept-Encoding`.

A reverse proxy or CDN that compresses passes these responses through. To leave compression to it, turn the option off:

```js
emdash({
	compression: false,
});
```

Cloudflare Workers sites and the Node adapter's middleware mode are not affected.
