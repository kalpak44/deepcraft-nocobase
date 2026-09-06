import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Switch, message as antdMessage } from 'antd';

interface ProviderStatus {
  configured: boolean;
  enabled: boolean;
  message?: string;
}

interface ConfigStatus {
  configured: boolean;
  defaultProvider: string;
  defaultModel?: string;
  message?: string;
  providers: Record<string, ProviderStatus>;
}

export interface ApiLike {
  request: (opts: { url: string; method: 'get' | 'post'; data?: unknown }) => Promise<any>;
}

export type Translator = (str: string, options?: Record<string, unknown>) => string;

export interface TranscriptionStatusCardProps {
  api: ApiLike;
  t: Translator;
}

const IconMic: React.FC = () => (
  <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 10v1a7 7 0 0014 0v-1" />
    <path d="M12 18v4M8 22h8" />
  </svg>
);

const IconRefresh: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 4v6h-6M1 20v-6h6" />
    <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
  </svg>
);

export const TranscriptionStatusCard: React.FC<TranscriptionStatusCardProps> = ({ api, t }) => {
  const [status, setStatus] = useState<ConfigStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyProvider, setBusyProvider] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.request({ url: 'transcription:configStatus', method: 'get' });
      setStatus(res?.data?.data || null);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleProvider = useCallback(
    async (name: string, enabled: boolean) => {
      setBusyProvider(name);
      try {
        await api.request({ url: 'transcription:setProviderEnabled', method: 'post', data: { provider: name, enabled } });
        setStatus((prev) =>
          prev ? { ...prev, providers: { ...prev.providers, [name]: { ...prev.providers[name], enabled } } } : prev,
        );
      } catch (err: any) {
        antdMessage.error(err?.message || String(err));
      } finally {
        setBusyProvider(null);
      }
    },
    [api],
  );

  const configured = !!status?.configured;

  return (
    <div style={cardStyle}>
      <div
        style={{
          position: 'absolute',
          top: 24,
          right: 28,
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          background: configured ? 'rgba(52,199,89,0.13)' : 'rgba(245,158,11,0.15)',
          borderRadius: 999,
          padding: '6px 16px',
          fontSize: 14,
          fontWeight: 600,
          color: configured ? '#1A8A3C' : '#B45309',
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            display: 'inline-block',
            background: configured ? '#34C759' : '#F59E0B',
          }}
        />
        {loading ? t('Checking…') : configured ? t('Configured') : t('Not configured')}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, marginBottom: 24 }}>
        <div
          style={{
            width: 72,
            height: 72,
            flexShrink: 0,
            background: '#fff',
            border: '1.5px solid #E4E4E4',
            borderRadius: 18,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <IconMic />
        </div>
        <div style={{ paddingTop: 4 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: '#111', lineHeight: 1.25, marginBottom: 6 }}>
            {t('Audio Transcription')}
          </div>
          <div style={{ fontSize: 15, color: '#666', lineHeight: 1.55 }}>
            {t('Lets AI employees transcribe audio (by URL or inline base64) via the transcribeAudio tool.')}
          </div>
        </div>
      </div>

      {error && (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 16, borderRadius: 10 }} />
      )}

      {!loading && !error && status && (
        <>
          <div style={{ display: 'flex', gap: 32, marginBottom: 20 }}>
            <div>
              <div style={labelStyle}>{t('Default provider')}</div>
              <div style={valueStyle}>{status.defaultProvider}</div>
            </div>
            <div>
              <div style={labelStyle}>{t('Default model')}</div>
              <div style={valueStyle}>{status.defaultModel || t('(active provider)')}</div>
            </div>
          </div>

          {!configured && status.message && (
            <Alert
              type="warning"
              showIcon
              message={t('Action needed')}
              description={status.message}
              style={{ marginBottom: 20, borderRadius: 10 }}
            />
          )}

          <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 700, color: '#444', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {t('Providers')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
            {Object.entries(status.providers).map(([name, p]) => (
              <div key={name} style={providerRowStyle}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    flexShrink: 0,
                    background: !p.enabled ? '#ABABAB' : p.configured ? '#34C759' : '#F59E0B',
                  }}
                />
                <span style={{ fontWeight: 600, color: '#222', minWidth: 90 }}>{name}</span>
                <span style={{ color: !p.enabled ? '#888' : p.configured ? '#1A8A3C' : '#B45309', fontSize: 13, flex: 1 }}>
                  {!p.enabled ? t('Disabled') : p.configured ? t('Configured') : p.message || t('Not configured')}
                </span>
                <Switch
                  size="small"
                  checked={p.enabled}
                  loading={busyProvider === name}
                  onChange={(checked) => toggleProvider(name, checked)}
                />
              </div>
            ))}
          </div>
        </>
      )}

      <Button onClick={refresh} loading={loading} style={refreshBtnStyle} icon={<IconRefresh />}>
        {t('Refresh')}
      </Button>
    </div>
  );
};

const cardStyle: React.CSSProperties = {
  position: 'relative',
  background: '#F8F9FA',
  border: '1.5px solid #E4E4E4',
  borderRadius: 20,
  padding: '28px 32px 32px',
  maxWidth: 660,
};

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  marginBottom: 4,
};

const valueStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 700,
  color: '#222',
  fontFamily: '"SF Mono", "Menlo", "Consolas", monospace',
};

const providerRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  background: '#EBEBEB',
  borderRadius: 10,
  padding: '10px 14px',
};

const refreshBtnStyle: React.CSSProperties = {
  height: 42,
  paddingInline: 24,
  borderRadius: 12,
  fontSize: 14,
  fontWeight: 700,
  background: '#fff',
  borderColor: '#D0D0D0',
  color: '#333',
  boxShadow: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
};

export default TranscriptionStatusCard;
