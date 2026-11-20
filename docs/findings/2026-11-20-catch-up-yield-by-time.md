# 読み直しの譲り方: 4MB ごとから 8ms ごとへ、同時の本数を 2 本に

- Date: 2026-11-20
- 対象: ccmsg v0.299.0 の daemon (`scanTranscriptLines` と transcript relay の追いつき)、bun 1.4.4、macOS (Darwin 25.5)
- 動機: issue `2026-11-12-catch-up-refold-holds-event-loop` (daemon の再起動の直後、live のセッションの transcript の読み直しで event loop が 100ms 以上塞がる) を、kawaz 裁定 (譲る刻みを時間に、同時の本数を絞る) で直す前後の計測
- 決めた値と理由は DR-0029 の追補「長い走査は時間で譲る」

## 判明した事実

- 直す前 (4MB ごとに 1 度譲る、本数の上限なし): 9 本 (合わせて 68〜72MB) の読み直しの間、ping の往復の最大は 235〜541ms。行の短い合成 (simple) が最も長く 476〜541ms、実物の transcript (real) は 252〜282ms
- 直した後 (8ms ごとに譲る、同時 2 本、小さい順): ping の往復の最大は 25〜34ms、中央値 10〜16ms、p90 20〜24ms。どの組でも同じ水準
- ほかの op が待つ長さは、ほぼ「同時に走る本数 × 刻み」で決まる。上限なしの 9 本で刻み 8ms だと最大 88〜96ms、刻み 16ms だと 141〜176ms。譲った走査のターンが次の周の check phase に並んで続けて走るため
- 読み直しの総時間 (9 本が全部着地するまで、ping を送らない run) は直す前より 8〜15% 長い。simple 1.08〜1.23 秒 → 1.18〜1.34 秒、rich 0.48〜0.53 秒 → 0.54〜0.59 秒、real 0.54〜0.59 秒 → 0.65〜0.70 秒
- 総時間の伸びは、行ごとの経過の確かめ (performance.now と止まる判定) からは来ていない: 刻みを 100 秒、上限を 99 にした (確かめるが譲らず絞らない) 版は、直す前と同じ (real 0.54〜0.59 秒)。刻み 2 / 4 / 8ms と上限 1 / 2 / 3 の間でも、総時間の差は run 間のばらつき (±10〜20%) の内だった。何に掛かっているかは特定していない
- 読み直しの重さは行の数で決まる。同じ 68MB で simple (約 21 万行) は約 1.1 秒、rich (約 2.6 万行、行の形が実物に似る) は約 0.5 秒、real (72MB、約 2.4 万行) は約 0.56 秒。読みと行の切り出しだけ (fold なし) なら simple の 68MB で 30〜60ms で、残りは 5 つの fold
- issue の元の計測 (12 本、ping 最大 125〜142ms、総時間 300ms 前後) より、今回の直す前の値は大きい。issue の計測のスクリプトは残っておらず、本数・行の形・v0.299.0 までの fold の追加のどれが効いているかは分けていない

## 実用的な示唆 / ベストプラクティス

- 長い走査の譲りはバイトや件数でなく時間で刻む。1 行・1 エントリの重さは形で桁が変わる
- 譲る走査を並べて走らせると、待ちは本数倍になる。時間の刻みと本数の上限は対で決める
- 隔離 daemon で op の待ちを測る時は、ping を間を空けずに送り続けて往復を全部取る。ping の処理も daemon の CPU を使うので、総時間は ping を送らない run で別に測る

## 検証の詳細

### 方法

- 隔離 daemon (test の `startTestDaemon` と同じ、子プロセス、HOME・state・data は一時ディレクトリ、HTTP と network watch と agents の poll は off)
- 9 つのセッション接続が、fixture の transcript を名乗って hello する (sid は新しく作り、transcript は `<sid>.jsonl` の hard link)
- 9 つが同時に `sidecar_hello` を送る (= 再起動の直後に一緒に live になる)。これが 9 本の読み直しを始める
- その間、別の user 接続が `ping` を間を空けずに送り続け、往復を全部記録する。もう 1 つの user 接続の `peers` (全部の読み直しの着地を待つ) が返るまでを総時間とする
- 各組 3 run (A/B の 5 run は個別に書く)。run ごとに daemon を起こし直す
- fixture の組
  - simple: 9 本 (5〜10MB、合わせて 68MB)、`{"type":"assistant","uuid":…,"message":{…"text":"line N xxx…"}}` の短い行 (約 350 バイト、合わせて約 21 万行)
  - rich: 9 本 (同じ大きさ)、実物に似た 4 種の行 (user の入力、thinking、tool_use、大きな tool_result) を順に (合わせて約 2.6 万行)
  - real: 実物の transcript 9 本 (5〜12MB、合わせて 72MB、約 2.4 万行) の複製。sid は新しく作った
- 直す前は v0.299.0 の daemon のソースの複製、直した後は本変更の workspace で測った

<details>
<summary>計測のスクリプト (bench.ts)</summary>

```ts
// usage: bun bench.ts <workspace> <fixture set dir> <runs> [noping]
import * as fs from "node:fs";
import * as path from "node:path";

const [ws, setDir, runsArg, mode] = process.argv.slice(2);
if (ws === undefined || setDir === undefined) throw new Error("usage");
const noPing = mode === "noping";
const runs = Number(runsArg ?? "3");
const h = await import(path.join(ws, "packages/daemon/test/helpers.ts"));

function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
}

const files = fs.readdirSync(setDir).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(setDir, f));
for (let run = 0; run < runs; run++) {
  const ctx = await h.startTestDaemon();
  try {
    const sessions = [];
    const runDir = fs.mkdtempSync(path.join(path.dirname(setDir), "run-"));
    for (const file of files) {
      const sid = crypto.randomUUID();
      const linked = path.join(runDir, `${sid}.jsonl`);
      fs.linkSync(file, linked);
      sessions.push(await h.sessionConn(ctx, sid, { transcript_path: linked }));
    }
    const pinger = await h.userConn(ctx);
    const observer = await h.userConn(ctx);
    for (let i = 0; i < 20; i++) await pinger.requestOk({ op: "ping" });
    let done = false;
    const rtts: number[] = [];
    const pingLoop = (async () => {
      while (!done && !noPing) {
        const t = performance.now();
        await pinger.requestOk({ op: "ping" });
        rtts.push(performance.now() - t);
      }
    })();
    const t0 = performance.now();
    await Promise.all(
      sessions.map((c) => c.requestOk({ op: "sidecar_hello", run_id: "run1", started_at: Date.now() })),
    );
    await observer.requestOk({ op: "peers" });
    const total = performance.now() - t0;
    done = true;
    await pingLoop;
    const sorted = [...rtts].sort((a, b) => a - b);
    console.log(JSON.stringify({
      set: path.basename(setDir), run, pings: rtts.length,
      max: sorted.at(-1) ?? 0, p50: pct(sorted, 50), p90: pct(sorted, 90), totalMs: total,
    }));
    for (const c of sessions) c.close();
    pinger.close();
    observer.close();
    fs.rmSync(runDir, { recursive: true, force: true });
  } finally {
    await h.stopTestDaemon(ctx);
  }
}
```

</details>

### 前後 (ping を送り続けた run、3 run の範囲、ms)

| 組 | 版 | ping の数 | ping 最大 | ping p50 | ping p90 | 総時間 |
|---|---|---|---|---|---|---|
| simple | 直す前 | 6〜7 | 476〜541 | 62〜258 | 476〜541 | 1,068〜1,149 |
| simple | 直した後 | 104〜123 | 27〜31 | 16 | 20〜24 | 1,292〜1,652 |
| rich | 直す前 | 5 | 235〜259 | 23〜35 | 235〜259 | 467〜494 |
| rich | 直した後 | 55〜62 | 26〜34 | 11〜13 | 23〜24 | 599〜785 |
| real | 直す前 | 6〜7 | 252〜282 | 17〜74 | 252〜282 | 552〜625 |
| real | 直した後 | 53〜63 | 25〜29 | 11〜16 | 22〜23 | 695〜763 |

直す前は ping が 1 回あたり数百 ms 待つので、run の間に 5〜7 回しか往復しない。直した後の総時間は、daemon が 100 回前後の ping にも答えている分を含む (総時間の比べは次の表)。

### 総時間 (ping を送らない run、ms)

| 組 | 直す前 | 直した後 (8ms、2 本) |
|---|---|---|
| simple | 1,079〜1,227 (6 run) | 1,180〜1,344 (3 run) |
| rich | 482〜526 (3 run) | 542〜587 (3 run) |
| real | 539〜593 (6 run)、5 run の中央値 565 | 645〜701 (3 run)、5 run の中央値 607 |

real の 5 run の A/B (交互に走らせた、中央値): 直す前 565、上限 1 で 620、上限 2 で 607、上限 9 で 694 (上限 9 は 568〜781 と二つに割れた)。刻み 100 秒・上限 99 (行ごとに確かめるが譲らず絞らない) は 4 run で 544〜592、直す前は同じ 4 run で 553〜578。

### 刻みと上限の掃引 (ping を送り続けた run、3 run の範囲、ms)

| 刻み | 上限 | 組 | ping 最大 | ping p50 | ping p90 | 総時間 |
|---|---|---|---|---|---|---|
| 2 | 2 | real | 16.5〜21.5 | 4.6〜5.3 | 6.4〜6.5 | 685〜737 |
| 2 | 2 | simple | 8.2〜16 | 4.1 | 6.2 | 1,346〜1,389 |
| 4 | 1 | real | 21.3〜33.4 | 0.8〜1.8 | 8.1 | 692〜697 |
| 4 | 1 | simple | 10.8〜17 | 4〜4.1 | 7.1〜7.7 | 1,289〜1,448 |
| 4 | 2 | real | 21.1〜37.9 | 8.2 | 12.3〜12.6 | 677〜754 |
| 4 | 2 | simple | 14.1〜24 | 8.1 | 12.2 | 1,288〜1,358 |
| 4 | 3 | real | 24.2〜34.3 | 12.2〜12.4 | 16.9〜17.3 | 681〜719 |
| 4 | 3 | simple | 18.9〜31.6 | 12.2 | 16.2〜16.3 | 1,289〜1,305 |
| 4 | 9 | real | 47.9〜60 | 33.3〜34.1 | 41.8〜44 | 574〜611 |
| 4 | 9 | simple | 45.2〜61.5 | 33.7〜36.2 | 40.8〜41.3 | 1,274〜1,318 |
| 8 | 1 | real | 24.7〜25.4 | 0.2 | 12.1〜13.7 | 657〜690 |
| 8 | 1 | simple | 20.4〜23.4 | 1.5〜7.9 | 9.2〜12.5 | 1,249〜1,446 |
| 8 | 2 | real | 27.9〜34.6 | 11.4〜16 | 23.4〜24.4 | 629〜721 |
| 8 | 2 | simple | 31〜37.1 | 13.5〜16.1 | 22〜24.2 | 1,307〜1,572 |
| 8 | 3 | real | 37.7〜42 | 16.8〜18.3 | 31.1〜32.8 | 626〜647 |
| 8 | 3 | simple | 38.2〜47 | 23.7〜24.2 | 31.2〜32.4 | 1,310〜1,331 |
| 8 | 9 | real | 88〜90.9 | 43.9〜67.2 | 78.5〜87.8 | 590〜605 |
| 8 | 9 | simple | 90.1〜95.7 | 59.7〜70 | 77.5〜80.3 | 1,192〜1,228 |
| 16 | 1 | real | 34.1〜47.4 | 0.1〜0.2 | 16.6〜25.2 | 562〜699 |
| 16 | 1 | simple | 32.7〜47.6 | 0.1〜0.7 | 17.6〜20.4 | 1,255〜1,344 |
| 16 | 2 | real | 47.7〜62.1 | 0.4〜7.4 | 30.3〜43.3 | 574〜666 |
| 16 | 2 | simple | 44.4〜53.5 | 17.8〜25.8 | 33.3〜34.1 | 1,256〜1,489 |
| 16 | 3 | real | 58.4〜83.7 | 26.9〜31.5 | 51.9〜53.6 | 645〜671 |
| 16 | 3 | simple | 63〜75.6 | 33.5〜34.1 | 49.2〜58.2 | 1,169〜1,229 |
| 16 | 9 | real | 141.1〜156.8 | 20.4〜49.6 | 141.1〜156.8 | 565〜575 |
| 16 | 9 | simple | 145.3〜175.8 | 59.4〜119.7 | 145.2〜155.1 | 1,161〜1,163 |

- p90 は上限 × 刻みに比例して伸びる (刻み 8ms で上限 1 / 2 / 3 / 9 → 12 / 24 / 32 / 80ms 前後)
- 最大は刻みと上限の積より数 ms〜十数 ms 上に出る。刻みを使い切った行の分、着地の時の fold の settle と続きの読み、ping そのものの処理が乗る

### 読みと行の切り出しだけの時間 (fold なし、simple の 9 本、ms)

| 版 | 順に 9 本 | 同時に 9 本 |
|---|---|---|
| 直す前 | 37〜47 | 28〜29 |
| 直した後 | 41〜61 | 34〜39 |

`performance.now()` 100 万回は 37〜59ms (行ごとに 1 回なので、simple の 21 万行で 8〜12ms 相当)。この表の「順に」「同時に」は 1 run で両方を続けて測った値。
