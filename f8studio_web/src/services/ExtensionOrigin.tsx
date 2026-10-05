import type { ExtensionStatus } from '../api/contracts.gen';

export function ExtensionOrigin({ extension }: { extension: ExtensionStatus }) {
  return <div className="extension-origin">
    {extension.sourceCheckout && <>
      <div className="extension-detail">Development source checkout</div>
      {!extension.releaseSha256 && <div className="extension-detail">Uses local source and build outputs; no release package imported.</div>}
      {extension.sourcePath && <details><summary>Source location</summary><code>{extension.sourcePath}</code></details>}
    </>}
    {extension.releaseSha256 ? <>
      <div className="extension-detail">Release package · v{extension.version}</div>
      <details><summary>Package verification</summary><dl className="extension-metadata"><dt>Archive SHA-256</dt><dd><code>{extension.releaseSha256}</code></dd></dl></details>
    </> : !extension.sourceCheckout && <div className="extension-detail">Local package · no verified release archive</div>}
    {extension.preinstalled && <div className="extension-detail">{extension.sourceCheckout ? 'Included in the development workspace preset.' : 'Included with this distribution.'}</div>}
  </div>;
}
