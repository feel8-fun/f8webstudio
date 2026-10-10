import { Bot, Cloud, Settings2 } from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { AgentSettingsContent } from '../agents/AgentSettings';
import { CloudAccount } from '../library/CloudAccount';
import { Modal } from './Modal';
import { SettingsContext, useSettings, type SettingsCategory } from './SettingsContext';

export function SettingsProvider({ children }: { readonly children: ReactNode }) {
  const [category, setCategory] = useState<SettingsCategory | null>(null);
  const close = useCallback(() => setCategory(null), []);
  return <SettingsContext value={setCategory}>
    {children}
    {category !== null && <Modal title="Settings" onClose={close} className="studio-settings agent-settings-dialog">
      <div className="studio-settings-columns">
        <nav aria-label="Settings categories">
          <button aria-current={category === 'ai' ? 'page' : undefined} onClick={() => setCategory('ai')}><Bot size={17}/>AI</button>
          <button aria-current={category === 'cloud' ? 'page' : undefined} onClick={() => setCategory('cloud')}><Cloud size={17}/>Cloud</button>
        </nav>
        <div className="studio-settings-content">
          <section hidden={category !== 'ai'} aria-label="AI settings"><h3>AI</h3><p>Manage model connections for agents and decision nodes.</p><AgentSettingsContent/></section>
          <section hidden={category !== 'cloud'} aria-label="Cloud settings"><h3>Cloud</h3><CloudAccount/></section>
        </div>
      </div>
    </Modal>}
  </SettingsContext>;
}

export function SettingsButton() {
  const openSettings = useSettings();
  return <button className="icon-button" type="button" aria-label="Settings" title="Settings" onClick={() => openSettings('ai')}><Settings2 size={16}/></button>;
}
