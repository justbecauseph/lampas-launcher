import type {
  LampasApi,
  RendererUserProfile,
  RendererSettingsDto,
  ModCatalogEntry,
  InstalledRuntimeInfo,
  SyncResult,
  SyncProgress,
  GameLogEntry,
  ServerStatus,
  DirectoryStatus,
  DirectoryValidationResult,
  DirectoryMoveProgress,
  DirectoryMoveResult,
  CustomClientMod,
  LauncherUpdateInfo,
} from "../../src/types";

export type {
  LampasApi,
  RendererUserProfile,
  RendererSettingsDto,
  ModCatalogEntry,
  InstalledRuntimeInfo,
  SyncResult,
  SyncProgress,
  GameLogEntry,
  ServerStatus,
  DirectoryStatus,
  DirectoryValidationResult,
  DirectoryMoveProgress,
  DirectoryMoveResult,
  CustomClientMod,
  LauncherUpdateInfo,
};

declare global {
  interface Window {
    lampas: LampasApi;
    LampasServerStatusView?: {
      getServerStatusView: (status: any) => any;
    };
  }
}
