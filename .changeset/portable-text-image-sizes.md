---
"emdash": minor
---

Adds an `imageSizes` prop to `PortableText` so rich-text images download at the width of the text column instead of the width of the uploaded file. Pass the column width in the syntax of the `sizes` attribute:

```astro
<PortableText value={post.data.content} imageSizes="(min-width: 800px) 680px, 92vw" />
```

Rich-text images also use `sizes="auto"`, so browsers that support it pick a file for the width the image is laid out at, with or without `imageSizes`.
