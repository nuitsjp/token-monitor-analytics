import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from "@fluentui/react-components";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FrontendAdapter } from "../lib/backend";

type CloseReason = "main" | "quit" | "navigate";

export interface DirtyStateGuardApi {
  request: (
    reason: CloseReason,
    action?: () => void | Promise<void>,
  ) => Promise<boolean>;
  dirty: boolean;
  pending: PendingRequest | null;
  confirm: () => Promise<void>;
  cancel: () => void;
}

interface PendingRequest {
  reason: CloseReason;
  action?: () => void | Promise<void>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useDirtyStateGuard(
  backend: FrontendAdapter,
  dirty: boolean,
): DirtyStateGuardApi {
  const dirtyRef = useRef(dirty);
  const [pending, setPending] = useState<PendingRequest | null>(null);

  useEffect(() => {
    dirtyRef.current = dirty;
    void backend.SetMainDirty(dirty).catch(() => undefined);
  }, [backend, dirty]);

  const request = useCallback(
    async (reason: CloseReason, action?: () => void | Promise<void>) => {
      if (!dirtyRef.current) {
        if (reason === "main") await backend.ConfirmCloseMain();
        else if (reason === "quit") await backend.ConfirmQuit();
        await action?.();
        return true;
      }
      setPending({ reason, action });
      return false;
    },
    [backend],
  );

  useEffect(() => {
    const removeClose = backend.on("window:main-close-requested", () => {
      void request("main");
    });
    const removeQuit = backend.on("app:quit-requested", () => {
      void request("quit");
    });
    return () => {
      removeClose();
      removeQuit();
    };
  }, [backend, request]);

  const confirm = useCallback(async () => {
    if (!pending) return;
    const requestToConfirm = pending;
    setPending(null);
    if (requestToConfirm.reason === "main") {
      await backend.ConfirmCloseMain();
    } else if (requestToConfirm.reason === "quit") {
      await backend.ConfirmQuit();
    }
    await requestToConfirm.action?.();
  }, [backend, pending]);

  const cancel = useCallback(() => setPending(null), []);

  return { request, dirty, pending, confirm, cancel };
}

export interface DirtyStateGuardProps {
  backend: FrontendAdapter;
  dirty: boolean;
  children: React.ReactNode;
}

export function DirtyStateGuard({
  backend,
  dirty,
  children,
}: DirtyStateGuardProps) {
  const guard = useDirtyStateGuard(backend, dirty);
  return (
    <>
      {children}
      <DirtyStateDialog guard={guard} />
    </>
  );
}

export function DirtyStateDialog({ guard }: { guard: DirtyStateGuardApi }) {
  const title =
    guard.pending?.reason === "quit"
      ? "アプリを終了しますか？"
      : guard.pending?.reason === "navigate"
        ? "別の画面へ移動しますか？"
        : "メイン画面を閉じますか？";
  return (
    <>
      <Dialog
        open={Boolean(guard.pending)}
        onOpenChange={(_, data) => !data.open && guard.cancel()}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>{title}</DialogTitle>
            <DialogContent>
              保存していない変更があります。変更を破棄して続行しますか？
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={guard.cancel}>
                キャンセル
              </Button>
              <Button appearance="primary" onClick={() => void guard.confirm()}>
                破棄して続行
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
