import { useEffect, useState } from 'react';
import { subscribeTrace, traceEvents, traceTotals } from '../ai/trace';

const kb = (b: number) => (b < 1024 ? `${b} B` : `${(b / 1024).toFixed(1)} KB`);

/** Header chip + panel: every model call this tab made, where it ran, and the bytes that left the device. */
export function HybridTrace() {
  const [, setTick] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => subscribeTrace(() => setTick((t) => t + 1)), []);
  const events = traceEvents();
  const t = traceTotals(events);
  return (
    <span className="trace-wrap">
      <button className={`btn small ${open ? 'active' : ''}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="hybrid-trace">
        AI calls <span className="tcount dev">{t.device} on device</span><span className="tcount cloud">{t.cloud} cloud</span>
      </button>
      {open && (
        <div className="trace-panel card" role="dialog" aria-label="Hybrid AI activity">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <b>Hybrid AI activity (this tab)</b>
            <span className="muted" style={{ fontSize: 12.5 }}>{kb(t.bytesOut)} left this device</span>
          </div>
          {events.length === 0 ? (
            <p className="muted" style={{ fontSize: 13 }}>No model calls yet.</p>
          ) : (
            <table className="mt-s">
              <thead><tr><th>Time</th><th>Task</th><th>Firebase AI Logic mode</th><th className="num">Sent</th><th className="num">ms</th></tr></thead>
              <tbody>
                {[...events].reverse().slice(0, 30).map((e, i) => (
                  <tr key={i} className={e.ok ? '' : 'failed'}>
                    <td className="mono">{new Date(e.at).toLocaleTimeString()}</td>
                    <td>{e.task}</td>
                    <td><span className={`badge ${e.where === 'device' ? '' : 'accent'}`}>{e.mode}</span></td>
                    <td className="num">{kb(e.bytesOut)}</td>
                    <td className="num">{e.ms}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>On-device calls send nothing. Cloud calls send only the payload you approved in the Privacy Firewall, or one alias-only pack item.</p>
        </div>
      )}
    </span>
  );
}
