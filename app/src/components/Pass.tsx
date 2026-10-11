import { countdown, duration, short, usdc } from "../lib/format";
import { useNow, type Resource } from "../lib/hooks";
import { useApp } from "../lib/store";

/**
 * The access pass: PayGate's one signature object. Unheld it reads as an offer (price, window);
 * held it turns USDC blue and the stub counts down to expiry.
 */
export function Pass({ r, until, holder, preview }: { r: Resource | null; until: number; holder?: string | null; preview?: boolean }) {
  const now = useNow();
  const { net } = useApp();
  const left = Math.max(0, until - now);
  const held = left > 0;
  const frac = r && held ? Math.min(1, left / Math.max(1, r.window)) : 0;

  return (
    <div className="pass-wrap">
    <div className={`pass ${held ? "held" : ""}`} aria-label={held ? "Active access pass" : "Access pass offer"}>
      <div className="pass-main">
        <div className="pass-top">
          <span className="pass-kicker">{preview ? "Preview · access pass" : `Access pass · ${net.short}`}</span>
          {held ? <span className="pill">Valid</span> : <span className="http s402">402</span>}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="pass-name">{r ? r.meta.name : "Resource"}</div>
          <div className="pass-endpoint">{r?.meta.host ? `${r.meta.host}${r.meta.path ?? ""}` : preview ? "endpoint not set yet" : r ? `resource #${r.id}` : "—"}</div>
        </div>
        <dl className="pass-grid">
          <div>
            <dt>Price</dt>
            <dd>{r ? `${usdc(r.price)} USDC` : "—"}</dd>
          </div>
          <div>
            <dt>Window</dt>
            <dd>{r ? duration(r.window) : "—"}</dd>
          </div>
          <div>
            <dt>{held ? "Holder" : "Sold"}</dt>
            <dd>{held ? short(holder) : r ? Number(r.sales).toLocaleString() : "—"}</dd>
          </div>
        </dl>
      </div>
      <div className="pass-stub">
        {held ? (
          <>
            <span className="small">Expires in</span>
            <span className="big num">{countdown(left)}</span>
            <div className="pass-bar" aria-hidden="true">
              <i style={{ width: `${frac * 100}%` }} />
            </div>
          </>
        ) : (
          <>
            <span className="small">Pay</span>
            <span className="big num">{r ? usdc(r.price) : "—"}</span>
            <span className="small">USDC</span>
          </>
        )}
      </div>
    </div>
    </div>
  );
}
