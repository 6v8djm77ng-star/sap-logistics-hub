/**
 * Global ErrorBoundary — A2g-FIX-WHITE-SCREEN (2026-05-20).
 *
 * Without one of these, any uncaught render error inside the React tree
 * unmounts the WHOLE app → blank white page. Operators have no way to
 * recover except hard-refresh + lose state.
 *
 * Strategy: catch render-time exceptions, show a small Hebrew RTL error
 * panel with the message + a "Reload" button. Logs the stack to the
 * console so DevTools still captures it.
 */
import { Component } from 'react';

export default class ErrorBoundary extends Component {
  state = { error: null, info: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the original stack visible in DevTools.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info);
    this.setState({ info });
  }

  handleReload = () => {
    window.location.reload();
  };

  handleHome = () => {
    window.location.href = '/';
  };

  render() {
    if (!this.state.error) return this.props.children;

    const msg = this.state.error?.message || String(this.state.error);
    const stack = this.state.info?.componentStack || '';

    return (
      <div dir="rtl" style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#fef2f2',
        padding: '20px',
        fontFamily: 'system-ui, sans-serif',
      }}>
        <div style={{
          maxWidth: '640px',
          width: '100%',
          background: 'white',
          border: '1px solid #fecaca',
          borderRadius: '12px',
          padding: '24px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
        }}>
          <h2 style={{ color: '#b91c1c', margin: '0 0 12px 0', fontSize: '20px' }}>
            ⚠️ אירעה שגיאה בטעינת המסך
          </h2>
          <p style={{ color: '#374151', margin: '0 0 16px 0', fontSize: '14px' }}>
            השרת פעיל ותקין. הבעיה בצד הלקוח — בדרך כלל בגלל data לא צפוי (למשל לחיצה על קישור לפריט שנמחק).
          </p>
          <div style={{
            background: '#f9fafb',
            border: '1px solid #e5e7eb',
            borderRadius: '8px',
            padding: '12px',
            margin: '0 0 16px 0',
            fontFamily: 'monospace',
            fontSize: '12px',
            color: '#dc2626',
            wordBreak: 'break-word',
            direction: 'ltr',
            textAlign: 'left',
          }}>
            {msg}
          </div>
          {stack ? (
            <details style={{ marginBottom: '16px' }}>
              <summary style={{ cursor: 'pointer', color: '#6b7280', fontSize: '12px' }}>
                פרטים טכניים (component stack)
              </summary>
              <pre style={{
                background: '#f9fafb',
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
                padding: '12px',
                marginTop: '8px',
                fontSize: '11px',
                color: '#374151',
                overflowX: 'auto',
                direction: 'ltr',
                textAlign: 'left',
              }}>{stack}</pre>
            </details>
          ) : null}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={this.handleReload}
              style={{
                background: '#2563eb',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                padding: '10px 16px',
                fontSize: '14px',
                cursor: 'pointer',
                fontWeight: 600,
              }}
            >
              רענן את הדף
            </button>
            <button
              onClick={this.handleHome}
              style={{
                background: 'white',
                color: '#374151',
                border: '1px solid #d1d5db',
                borderRadius: '8px',
                padding: '10px 16px',
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              דף הבית
            </button>
          </div>
        </div>
      </div>
    );
  }
}
