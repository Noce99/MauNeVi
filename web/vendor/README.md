# Vendored

`elk.bundled.js` is [elkjs](https://github.com/kieler/elkjs) 0.10.0 (the Eclipse
Layout Kernel compiled to JavaScript), unmodified, under the EPL-2.0
(`elkjs-LICENSE.md`). It lays out the nested block diagrams. To update it:
`npm pack elkjs@<version>`, copy `lib/elk.bundled.js` and `LICENSE.md` here,
and run `node --test web/test`.
