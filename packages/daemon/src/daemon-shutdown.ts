export interface DaemonShutdownResources {
  stopHttp(): Promise<void>;
  removePid(): void;
  releaseLock(): void;
  stopUds(): void;
}

/** 規約 (DR-0002 §4): 後継 daemon はクライアントが観測した「UDS に繋がらない」を
 * 旧 daemon の退去完了として起動する。だから UDS の close は、後継と競合しうる
 * 全資源 (HTTP listen port / pid file / lock) を手放した**最後**に行う。順序が
 * 逆だと、後継が bind や lock 取得に失敗する窓ができる。socket pathname の
 * unlink はここではしない — lock を得た後継の起動時 cleanup の責務で、旧側が
 * 消すと後継が bind した直後の新 socket を消す race になる。 */
export async function releaseDaemonResources(resources: DaemonShutdownResources): Promise<void> {
  await resources.stopHttp();
  resources.removePid();
  resources.releaseLock();
  resources.stopUds();
}
