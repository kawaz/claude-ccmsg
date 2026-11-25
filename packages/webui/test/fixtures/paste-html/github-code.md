### 1. 層の関係 (`$defaults` の意味)

- プロジェクトの設定は足すだけ。プロジェクトの項目はユーザの設定に連結され、ユーザの項目もユーザの `$defaults` も消せない (実測)。組み込みの既定を消す経路も持たない
- daemon は、プロジェクトに項目があるセクションの settings に常に `$defaults` を先頭に入れる (§4)。ユーザがそのリストを書いていない時に `$defaults` なしで項目を足すと組み込みの既定が消える (実測の表の「書いていない / 1 件、`$defaults` なし」) ので、それを起こさないため
- `$defaults` はプロジェクトの項目にならない。人が入れ外しする操作も、画面の表示も持たない (§6)
- セクションごとに、P = プロジェクトに項目がある、U = ユーザがそのリストを空でなく書いている、Ud = ユーザのリストに `$defaults` がある、とすると:
  - 組み込みが効く = P または (U かつ Ud) または (U でない)。言い換えると、効かないのは「ユーザが `$defaults` なしで書いていて、プロジェクトに項目が無い」時だけ
  - 効くリストの中身 = ユーザの項目 (Ud なら `$defaults` の位置に組み込み) に続けて、P なら組み込み (ユーザの側で既に入っていれば 1 回だけ) とプロジェクトの項目
- 端の場合: ユーザがそのリストを `$defaults` なしで書いて組み込みを外している時、プロジェクトがそのセクションに項目を足すと、そのプロジェクトでは組み込みが戻る (実測の表の「1 件、`$defaults` なし / `["$defaults"]` → 73」)。classifier の説明が増える向き (soft\_deny では止める項目が増える安全側) なので、このままにする

### 2. 置き場と形

- 置き場は ccmsg の config dir の `project-auto-mode.json` (`Paths.projectAutoMode`)。人が手で直してもよい設定なので config dir に置き、daemon が webui の操作で書く。書く時は一時ファイルに書き、fsync してから rename する。`project-auto-mode.json` が symlink (dotfiles から張る等) の時は、その実体 (realpath) の隣に一時ファイルを作って実体を置き換え、symlink は残す。mode は元のファイルのものを保つ (無ければ 0644)。daemon は自分が読み直せない内容を書かない (書く前にスキーマで読み直す)
- 形 (valibot、protocol に置く):

```ts
const AutoModeEntrySchema = v.pipe(
  v.string(),
  v.trim(),
  v.minLength(1),
  v.maxLength(2000),
  v.check((s) => s !== "$defaults", "$defaults is not an entry"),
);
/** セクションは項目のリスト (保存の順) */
const AutoModeSectionSchema = v.array(AutoModeEntrySchema);
const AutoModeSectionsSchema = v.strictObject({
  environment: v.optional(AutoModeSectionSchema, []),
  allow: v.optional(AutoModeSectionSchema, []),
  soft_deny: v.optional(AutoModeSectionSchema, []),
  hard_deny: v.optional(AutoModeSectionSchema, []),
});
const ProjectAutoModeFileSchema = jsonText(
  v.strictObject({ projects: v.record(ProjectKeySchema, AutoModeSectionsSchema) }),
);
```

- `ProjectKeySchema` はプロジェクトのキー (§3)。書く時は項目の無いセクションを省き、4 つのセクションが全部空になったキーはキーごと消す。形は Claude Code の settings の `autoMode` のリストと同じ (`{"projects": {"repo:github.com/o/r": {"allow": ["..."]}}}`)
- 項目は文 (classifier が自然文として読む)。中の改行は許す。前後の空白は落とす
- 上限: 1 項目 2000 文字、1 プロジェクトの settings の JSON が 32 KiB まで。classifier の判定ごとに文脈に載るため。32 KiB は webui からの保存 (`project_auto_mode_write`) の時だけ確かめ、起動では確かめない (手で直したファイルが超えていてもそのまま渡す)。保存は、書いた後の大きさが 32 KiB を超え、かつ書く前より大きくなる時だけ `invalid_args` で断る。手で直して超えたプロジェクトでも、消す・短くする保存は通る (それで上限の内に戻せる)
- ファイルは読むたびに読み直す (起動のたびと op のたび。小さいので持たない)。手で直した内容が daemon の再起動なしに次の起動から効く
