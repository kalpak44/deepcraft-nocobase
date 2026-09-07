import React from 'react';
import { BlockModel } from '@nocobase/client-v2';
import { useFlowContext } from '@nocobase/flow-engine';
import { ConnectionCard } from '../../shared/ConnectionCard';
import { tExpr, useT } from '../locale';

const ConnectionCardV2: React.FC<{ title: string; showScopes: boolean }> = ({ title, showScopes }) => {
  const t = useT();
  const { api } = useFlowContext();
  return <ConnectionCard api={api} t={t} title={title} showScopes={showScopes} />;
};

export class MsConnectBlockModel extends BlockModel {
  renderComponent() {
    const title = (this.props?.title as string) || '';
    const showScopes = this.props?.showScopes !== false;
    return <ConnectionCardV2 title={title} showScopes={showScopes} />;
  }
}

MsConnectBlockModel.define({
  label: tExpr('Connect Microsoft'),
  group: 'others',
});

MsConnectBlockModel.registerFlow({
  key: 'msConnectBlockSettings',
  title: tExpr('Microsoft Connect settings'),
  on: 'beforeRender',
  steps: {
    setup: {
      title: tExpr('Microsoft Connect settings'),
      uiSchema: {
        title: {
          type: 'string',
          title: tExpr('Card title'),
          'x-decorator': 'FormItem',
          'x-component': 'Input',
        },
        showScopes: {
          type: 'boolean',
          title: tExpr('Show scopes'),
          'x-decorator': 'FormItem',
          'x-component': 'Switch',
        },
      },
      defaultParams: {
        title: '',
        showScopes: true,
      },
      handler(ctx, params) {
        ctx.model.props.title = params.title;
        ctx.model.props.showScopes = params.showScopes;
      },
    },
  },
});

export default MsConnectBlockModel;
