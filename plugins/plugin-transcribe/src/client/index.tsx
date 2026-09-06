import React from 'react';
import { Plugin, useAPIClient } from '@nocobase/client';
import { useTranslation } from 'react-i18next';
import { TranscriptionStatusCard } from '../shared/TranscriptionStatusCard';
// @ts-ignore
import pkg from '../../package.json';

const NS = pkg.name;

const TranscriptionSettingsPage: React.FC = () => {
  const api = useAPIClient();
  const { t } = useTranslation(NS);
  return (
    <div style={{ padding: 24 }}>
      <TranscriptionStatusCard api={api} t={t as any} />
    </div>
  );
};

export class PluginNocoTranscribeV1Client extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(NS, {
      title: `{{t("Transcription", { ns: "${NS}" })}}`,
      icon: 'AudioOutlined',
      Component: TranscriptionSettingsPage,
    });
  }
}

export default PluginNocoTranscribeV1Client;
