---
"@emdash-cms/blocks": patch
---

Makes `BlockRenderer` load ECharts only when a `chart` block renders. Before, ECharts (about 200 KB gzip) loaded with every block renderer, including on admin screens that show no chart. A chart block now reserves its height while ECharts loads, and then renders as before. The package's exports are unchanged.
