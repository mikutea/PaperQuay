import type {NoteData} from '../../../../packages/sync-core/src/index.ts';
import type {AiAccountScope,AiSaveContext,AiTransport,PdfAiContext,PdfCitationTarget,SecretStore} from '../../../../packages/ai-core/src/types.ts';
import type { AiSyncBridge } from '../integration/aiSync.ts';
export * from '../../../../packages/ai-core/src/types.ts';
export interface AiWorkspaceProps {
  onSettingsBack?: () => void;
  settingsBackLabel?: string;
  onSettingsDirty?: (dirty: boolean) => void;
  onSettingsSaved?: () => void;
  mode?: 'reader' | 'settings';
  archiveEpoch?: number;
  accountScope: AiAccountScope;
  context: PdfAiContext | null;
  secretStore: SecretStore;
  transport?: AiTransport;
  modelLedgerRevision?:number;
  modelRouter?: import('../modelRouting/router.ts').MobileModelRouter;
  sync?: AiSyncBridge;
  onRestoreContext?(context: PdfAiContext): void;
  onSaveNote(note: NoteData, source: AiSaveContext): Promise<void>;
  onNavigateCitation(target: PdfCitationTarget): void;
}
