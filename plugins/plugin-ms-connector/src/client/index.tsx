import React from 'react';
import { Plugin, useAPIClient } from '@nocobase/client';
import { useTranslation } from 'react-i18next';
import { ConnectionCard } from '../shared/ConnectionCard';
// @ts-ignore
import pkg from '../../package.json';

const NS = pkg.name;

const ConnectMsSettingsPage: React.FC = () => {
  const api = useAPIClient();
  const { t } = useTranslation(NS);
  return (
    <div style={{ padding: 24 }}>
      <ConnectionCard api={api} t={t as any} />
    </div>
  );
};

export class PluginMsConnectorV1Client extends Plugin {
  async load() {
    this.app.pluginSettingsManager.add(NS, {
      title: `{{t("Connect Microsoft", { ns: "${NS}" })}}`,
      icon: 'WindowsOutlined',
      Component: ConnectMsSettingsPage,
    });
  }
}

export default PluginMsConnectorV1Client;
