---
'@sitecore-content-sdk/content': patch
'@sitecore-content-sdk/nextjs': patch
'create-content-sdk-app': patch
---

Hide datasource field values in Pages when the current editor is denied Read.

Preview/editing layout requests forward the Pages user token (`Authorization` or `sc_preview_token`). Edit-mode `item.rendered` still serializes denied datasource values, so EditingService rechecks each datasource as that user and clears field values the user cannot read. New `getEditingFetchOptions` helper; Pages Router and App Router templates pass it to `getPreview` / `getDesignLibraryData`.
