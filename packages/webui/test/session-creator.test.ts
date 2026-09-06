// DR-0018 §2.1: pure form-state helpers for SessionCreator.tsx (params-driven
// construction, run-button validity gate, wire-request projection).
import { describe, expect, test } from "bun:test";
import type { LauncherParam, SessionLauncherConfigTemplate } from "@ccmsg/protocol";
import {
  buildSessionLaunchRequest,
  commitCwdInput,
  plainTemplate,
  forkSourceDefaults,
  forkTemplate,
  resumeTemplate,
  initialTemplate,
  launcherEffortFromTranscript,
  launcherModelFromTranscript,
  orderedParams,
  paramRows,
  paramWidget,
  selectSessionCreatorTemplate,
  sessionCreatorCwd,
  templateDeclares,
  initialCwdPickerMode,
  initialSessionCreatorForm,
  prefillSidebarState,
  sessionCreatorFormValid,
  SESSION_CREATOR_EFFORTS,
  SESSION_CREATOR_MODELS,
  type SessionCreatorForm,
  type SessionCreatorPrefill,
} from "../src/client/session-creator.ts";

/** 「セッションを選んでランチャーを開く」経路を、本番と同じ 2 段で通す:
 * 呼び出し元が prefill から `sb.*` を組み (prefillSidebarState)、フォームは
 * その URL 状態だけを見て初期化される。ここを 1 本の helper にしておくと、
 * 以降の期待値が「fork / resume のリンクを開いたら何が入るか」を素直に
 * 表したままになる。 */
function formFromPrefill(
  templates: SessionLauncherConfigTemplate[],
  prefill: SessionCreatorPrefill,
  defaults: Record<string, string> = {},
): SessionCreatorForm {
  const url = prefillSidebarState(prefill);
  return initialSessionCreatorForm(templates, url.template, url.params, defaults);
}

function templateFromPrefill(
  templates: SessionLauncherConfigTemplate[],
  prefill: SessionCreatorPrefill,
): SessionLauncherConfigTemplate | undefined {
  const url = prefillSidebarState(prefill);
  return initialTemplate(templates, url.template, url.params);
}

/** One configured recipe, as session_launcher_config projects it. `params` is
 * written as a name→default object for readability and kept in that order — the
 * wire form is the ordered array the form renders from. */
function template(
  name: string,
  command: string,
  params: Record<string, string> = {},
): SessionLauncherConfigTemplate {
  const declared: LauncherParam[] = Object.entries(params).map(([n, d]) => ({
    name: n,
    default: d,
  }));
  return { name, command, params: declared };
}

const PLAIN = template("default", "run-launch", {
  CWD: "",
  MODEL: "fable",
  EFFORT: "medium",
  PROMPT: "hello",
});
const FORK = template("fork", 'run --resume "$SESSION_ID" --resume-session-at="$RESUME_AT"', {
  CWD: "",
  MODEL: "fable",
  EFFORT: "medium",
  PROMPT: "",
  SESSION_ID: "",
  RESUME_AT: "",
});

const RESUME = template(
  "resume",
  'run --resume "$SESSION_ID" --model "$MODEL" --effort "$EFFORT" --name "$TITLE"',
  {
    CWD: "",
    SESSION_ID: "",
    MODEL: "fable",
    EFFORT: "medium",
    TITLE: "",
    PROMPT: "",
  },
);

const FORK_PREFILL = { kind: "fork", sessionId: "sid-1", resumeAt: "u-9" } as const;
const RESUME_PREFILL = { kind: "resume", cwd: "/repos/app", sessionId: "sid-1" } as const;

describe("initialSessionCreatorForm", () => {
  test("seeds every declared parameter from its configured default", () => {
    expect(initialSessionCreatorForm([PLAIN])).toEqual({
      template: "default",
      command: "run-launch",
      params: { CWD: "", MODEL: "fable", EFFORT: "medium", PROMPT: "hello" },
    });
  });

  // The declaration is the only source of fields: a recipe that declares two
  // parameters gets two, whatever the command text happens to mention.
  test("undeclared variables get no value, even when the command reads them", () => {
    const form = initialSessionCreatorForm([template("t", 'run "$MODEL" "$PROMPT"', { CWD: "" })]);
    expect(form.params).toEqual({ CWD: "" });
  });

  test("a parameter this webui has never heard of is seeded like any other", () => {
    const form = initialSessionCreatorForm([
      template("t", 'run "$BRANCH"', { CWD: "", BRANCH: "main" }),
    ]);
    expect(form.params).toEqual({ CWD: "", BRANCH: "main" });
  });

  test("carries a default verbatim, including empty and multi-line strings", () => {
    expect(initialSessionCreatorForm([template("t", "cmd", { PROMPT: "" })]).params.PROMPT).toBe(
      "",
    );
    expect(
      initialSessionCreatorForm([template("t", "cmd", { PROMPT: "multi\nline\n" })]).params.PROMPT,
    ).toBe("multi\nline\n");
  });

  // The command template is a shell body with `$CWD`/`$MODEL`/… refs — the
  // daemon never substitutes them, and neither does the form. The user should
  // see exactly what the daemon will run.
  test("carries the template's command verbatim, including $VAR refs and newlines", () => {
    const cmd = 'claude --model "$MODEL" --effort "$EFFORT"\n"$PROMPT"';
    expect(initialSessionCreatorForm([template("t", cmd)]).command).toBe(cmd);
  });

  // A fork opens on a recipe that actually declares the fork point, whatever
  // its position in the list, and carries the fork values into the form.
  test("a fork prefill opens on the fork recipe with the fork point filled in", () => {
    const form = formFromPrefill([PLAIN, FORK], FORK_PREFILL);
    expect(form).toMatchObject({ template: "fork", command: FORK.command });
    expect(form.params).toMatchObject({ SESSION_ID: "sid-1", RESUME_AT: "u-9" });
  });

  // With no fork-capable recipe configured the form still opens (on the
  // default); the fork values have nowhere to go and are dropped rather than
  // riding along invisibly in a request nothing would read.
  test("a fork prefill falls back to the default recipe, dropping undeclared fork values", () => {
    const form = formFromPrefill([PLAIN], FORK_PREFILL);
    expect(form.template).toBe("default");
    expect(form.params).not.toHaveProperty("RESUME_AT");
  });

  // Fork-source defaults win over the declared defaults, parameter by parameter.
  test("applies the fork source's cwd/model/effort when given", () => {
    const form = formFromPrefill([PLAIN, FORK], FORK_PREFILL, {
      CWD: "/repos/app",
      MODEL: "opus",
      EFFORT: "high",
    });
    expect(form.params).toMatchObject({ CWD: "/repos/app", MODEL: "opus", EFFORT: "high" });
  });

  // A fork of a session that is no longer connected (the sidebar's 前回稼働中
  // row, kawaz r259 m42) has no live AppState to read its context out of, so
  // it carries the daemon's frozen record on the prefill instead — same fields
  // a resume carries, mapped the same way.
  test("a fork prefill can carry its own cwd/model/effort/title", () => {
    const forkWithTitle = template("fork", "run-fork", {
      CWD: "",
      MODEL: "fable",
      EFFORT: "medium",
      TITLE: "",
      SESSION_ID: "",
      RESUME_AT: "",
    });
    const form = formFromPrefill([PLAIN, forkWithTitle], {
      kind: "fork",
      sessionId: "sid-1",
      resumeAt: "",
      cwd: "/repos/app",
      model: "claude-opus-5[1m]",
      effort: "high",
      title: "案件メモ",
    });
    expect(form.template).toBe("fork");
    expect(form.params).toMatchObject({
      CWD: "/repos/app",
      MODEL: "opus",
      EFFORT: "high",
      TITLE: "案件メモ",
      SESSION_ID: "sid-1",
      RESUME_AT: "",
    });
  });

  // The Timeline's fork knows none of that (it reads live state instead), and
  // must keep behaving exactly as it did — an absent field is not an empty one.
  test("a fork prefill without them leaves the declared defaults alone", () => {
    const form = formFromPrefill([PLAIN, FORK], FORK_PREFILL);
    expect(form.params).toMatchObject({ CWD: "", MODEL: "fable", EFFORT: "medium" });
  });

  // A resume brings its own cwd (the search hit knows where the session ran —
  // a historical session has no live peer row to inherit one from).
  test("a resume prefill opens on the resume recipe with cwd and session id filled in", () => {
    const form = formFromPrefill([PLAIN, RESUME], RESUME_PREFILL);
    expect(form).toMatchObject({ template: "resume", command: RESUME.command });
    expect(form.params).toMatchObject({ CWD: "/repos/app", SESSION_ID: "sid-1" });
  });

  // Resuming re-enters the session itself, so it has to run as what it already
  // is: without this the launcher's own default would silently switch a
  // resumed session's model.
  test("a resume prefill seeds the session's own model and effort", () => {
    const form = formFromPrefill([PLAIN, RESUME], {
      ...RESUME_PREFILL,
      model: "claude-opus-5[1m]",
      effort: "high",
    });
    expect(form.params).toMatchObject({ MODEL: "opus", EFFORT: "high" });
  });

  // `claude --resume` comes back under a name it derives from the directory
  // unless it is told one, and that derived name then wins over the session's
  // own title wherever live name does. Carrying the title into the recipe's
  // TITLE parameter is what keeps a resumed session called what it was.
  test("a resume prefill seeds the session's own title", () => {
    const form = formFromPrefill([PLAIN, RESUME], {
      ...RESUME_PREFILL,
      title: "案件メモ",
    });
    expect(form.params).toMatchObject({ TITLE: "案件メモ", SESSION_ID: "sid-1" });
  });

  // A session that was never renamed has no title to carry: the parameter
  // stays at its declared default (empty), which is the recipe's signal to
  // launch without --name rather than with an empty one.
  test("a resume prefill with no title leaves the declared default in place", () => {
    expect(formFromPrefill([PLAIN, RESUME], RESUME_PREFILL).params.TITLE).toBe("");
    expect(formFromPrefill([PLAIN, RESUME], { ...RESUME_PREFILL, title: "   " }).params.TITLE).toBe(
      "",
    );
  });

  // An un-migrated resume recipe that predates the TITLE parameter: the seed
  // has nowhere to land and is dropped, exactly like an undeclared model.
  test("a resume recipe declaring no title ignores that seed", () => {
    const bare = template("resume", 'run --resume "$SESSION_ID"', { CWD: "", SESSION_ID: "" });
    const form = formFromPrefill([bare], { ...RESUME_PREFILL, title: "案件メモ" });
    expect(form.params).toEqual({ CWD: "/repos/app", SESSION_ID: "sid-1" });
  });

  // Same rule as a fork's: a value with no honest mapping leaves the declared
  // default alone rather than guessing at one.
  test("a resume prefill the form cannot map keeps the declared defaults", () => {
    const form = formFromPrefill([PLAIN, RESUME], {
      ...RESUME_PREFILL,
      model: "<synthetic>",
      effort: "ultra",
    });
    expect(form.params).toMatchObject({ MODEL: "fable", EFFORT: "medium" });
  });

  // An un-migrated config whose resume recipe takes neither: the seed has
  // nowhere to land, and the form still shows exactly what it declares.
  test("a resume recipe declaring no model or effort ignores those seeds", () => {
    const bare = template("resume", 'run --resume "$SESSION_ID"', { CWD: "", SESSION_ID: "" });
    const form = formFromPrefill([bare], {
      ...RESUME_PREFILL,
      model: "claude-opus-5",
      effort: "high",
    });
    expect(form.params).toEqual({ CWD: "/repos/app", SESSION_ID: "sid-1" });
  });

  // A hit whose cwd the daemon could not establish opens the form anyway; the
  // declared default survives and the run button gates on the empty cwd.
  test("a resume prefill without a cwd leaves the declared default in place", () => {
    const withDefault = template("resume", "run", { CWD: "/repos/fallback", SESSION_ID: "" });
    const form = formFromPrefill([withDefault], {
      kind: "resume",
      cwd: "",
      sessionId: "sid-1",
    });
    expect(form.params).toEqual({ CWD: "/repos/fallback", SESSION_ID: "sid-1" });
  });

  // With no resume recipe configured the session id has nowhere to go, exactly
  // like a fork point does not (the cwd still lands, since every recipe
  // declares CWD).
  test("a resume prefill falls back to the default recipe, dropping the session id", () => {
    const form = formFromPrefill([PLAIN], RESUME_PREFILL);
    expect(form.template).toBe("default");
    expect(form.params).not.toHaveProperty("SESSION_ID");
    expect(form.params).toMatchObject({ CWD: "/repos/app" });
  });

  // A partial inheritance leaves the untouched parameters at their declared
  // defaults.
  test("parameters absent from the defaults keep their declared defaults", () => {
    const form = initialSessionCreatorForm([PLAIN], null, { MODEL: "sonnet" });
    expect(form.params).toMatchObject({ CWD: "", MODEL: "sonnet", EFFORT: "medium" });
  });
});

describe("paramWidget", () => {
  const p = (name: string, def = ""): LauncherParam => ({ name, default: def });

  // The three names the form has a real control for; everything else is text.
  test("known names map to their control", () => {
    expect(paramWidget(p("CWD"), "")).toBe("cwd");
    expect(paramWidget(p("MODEL"), "")).toBe("model");
    expect(paramWidget(p("EFFORT"), "")).toBe("effort");
  });

  // kawaz r259 m47: PROMPT is not special — how much room a value needs is a
  // property of the value, not of the name it was given.
  test("everything else is sized by whether the value has newlines", () => {
    expect(paramWidget(p("PROMPT"), "one line")).toBe("text");
    expect(paramWidget(p("PROMPT"), "two\nlines")).toBe("multiline");
    expect(paramWidget(p("SESSION_ID"), "sid-1")).toBe("text");
    expect(paramWidget(p("BRANCH"), "main")).toBe("text");
  });

  // A recipe whose default is multi-line keeps its box while the text in it
  // happens to be one line, so the field does not collapse mid-edit.
  test("a multi-line default keeps the box even when the value is one line", () => {
    expect(paramWidget(p("PROMPT", "a\nb"), "a")).toBe("multiline");
  });
});

describe("paramRows", () => {
  test("行数 + 2 — 常に 1 行足す余地が見えている", () => {
    expect(paramRows("")).toBe(3);
    expect(paramRows("a\nb")).toBe(4);
    expect(paramRows("a\nb\n")).toBe(5);
  });
});

describe("orderedParams", () => {
  const names = (params: LauncherParam[]): string[] =>
    orderedParams(params).map((param) => param.name);

  // kawaz r259 m47: cwd/model/effort first in that order, COMMAND last,
  // everything else in the order the config declared it.
  test("cwd/model/effort go first in that order, whatever the declaration order", () => {
    expect(
      names([
        { name: "EFFORT", default: "" },
        { name: "PROMPT", default: "" },
        { name: "CWD", default: "" },
        { name: "MODEL", default: "" },
      ]),
    ).toEqual(["CWD", "MODEL", "EFFORT", "PROMPT"]);
  });

  test("a COMMAND parameter goes last", () => {
    expect(
      names([
        { name: "COMMAND", default: "" },
        { name: "CWD", default: "" },
        { name: "BRANCH", default: "" },
      ]),
    ).toEqual(["CWD", "BRANCH", "COMMAND"]);
  });

  test("the rest keep their declaration order — that order is the config's statement", () => {
    expect(
      names([
        { name: "SESSION_ID", default: "" },
        { name: "RESUME_AT", default: "" },
        { name: "PROMPT", default: "" },
      ]),
    ).toEqual(["SESSION_ID", "RESUME_AT", "PROMPT"]);
  });

  test("a template that declares none of the special names is left alone", () => {
    const params = [
      { name: "B", default: "" },
      { name: "A", default: "" },
    ];
    expect(names(params)).toEqual(["B", "A"]);
  });
});

describe("forkSourceDefaults", () => {
  const ROOTS = ["/repos", "/srv/work/"];

  test("takes cwd from the source when it sits under a configured root", () => {
    expect(forkSourceDefaults({ cwd: "/repos/app/main" }, ROOTS)).toEqual({
      CWD: "/repos/app/main",
    });
    // The root itself is a legal pick, and a root written with a trailing
    // slash matches the same paths as one without.
    expect(forkSourceDefaults({ cwd: "/repos" }, ROOTS)).toEqual({ CWD: "/repos" });
    expect(forkSourceDefaults({ cwd: "/srv/work/x" }, ROOTS)).toEqual({ CWD: "/srv/work/x" });
  });

  // Seeding a cwd the daemon would refuse would leave the user pressing 実行
  // on a path that cannot launch; an empty picker is the honest state.
  test("drops a cwd outside the configured roots, including sibling-prefix paths", () => {
    expect(forkSourceDefaults({ cwd: "/elsewhere/app" }, ROOTS)).toEqual({});
    expect(forkSourceDefaults({ cwd: "/repos-other/app" }, ROOTS)).toEqual({});
    expect(forkSourceDefaults({ cwd: "relative/path" }, ROOTS)).toEqual({});
    expect(forkSourceDefaults({ cwd: "   " }, ROOTS)).toEqual({});
  });

  test("seeds TITLE from the source session's name (kawaz r259m62)", () => {
    expect(forkSourceDefaults({ title: "my session" }, ROOTS)).toEqual({ TITLE: "my session" });
    expect(forkSourceDefaults({ title: "   " }, ROOTS)).toEqual({});
  });

  test("nothing is inherited when the fork source could not be identified", () => {
    expect(forkSourceDefaults(null, ROOTS)).toEqual({});
    expect(forkSourceDefaults({}, ROOTS)).toEqual({});
  });

  test("maps model and effort into the form's vocabulary", () => {
    expect(forkSourceDefaults({ model: "claude-fable-5[1m]", effort: "medium" }, ROOTS)).toEqual({
      MODEL: "fable",
      EFFORT: "medium",
    });
  });
});

describe("launcherModelFromTranscript", () => {
  // The form offers families; a transcript records the concrete model, with a
  // launch-only [1m] suffix on long-context sessions.
  test("reduces a claude model id to its family, suffix included", () => {
    expect(launcherModelFromTranscript("claude-fable-5")).toBe("fable");
    expect(launcherModelFromTranscript("claude-opus-5[1m]")).toBe("opus");
    expect(launcherModelFromTranscript("claude-sonnet-5")).toBe("sonnet");
    expect(launcherModelFromTranscript("claude-opus-4-7")).toBe("opus");
  });

  test("ids that already are an option pass through", () => {
    expect(launcherModelFromTranscript("gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(launcherModelFromTranscript("opus")).toBe("opus");
  });

  // Synthetic harness rows and families with no dropdown entry have no honest
  // answer — the caller keeps the declared default rather than guessing.
  test("unknown values map to nothing", () => {
    expect(launcherModelFromTranscript("<synthetic>")).toBeUndefined();
    expect(launcherModelFromTranscript("claude-haiku-4-5-20251001")).toBeUndefined();
    expect(launcherModelFromTranscript("")).toBeUndefined();
  });
});

describe("launcherEffortFromTranscript", () => {
  // Transcript and form share the CLI's vocabulary, so every offered level
  // survives the trip verbatim — a value that came back changed would be a
  // level `claude --effort` does not accept.
  test("every offered level passes through", () => {
    expect(launcherEffortFromTranscript("medium")).toBe("medium");
    for (const effort of SESSION_CREATOR_EFFORTS) {
      expect(launcherEffortFromTranscript(effort)).toBe(effort);
    }
  });

  test("unknown values map to nothing", () => {
    expect(launcherEffortFromTranscript("ultra")).toBeUndefined();
    expect(launcherEffortFromTranscript("middle")).toBeUndefined();
    expect(launcherEffortFromTranscript("")).toBeUndefined();
  });
});

describe("forkTemplate / initialTemplate", () => {
  // Fork capability is read off the declaration: a recipe that never takes the
  // fork point cannot fork regardless of its name or its command text.
  test("picks the first recipe declaring the fork point", () => {
    expect(forkTemplate([PLAIN, FORK])?.name).toBe("fork");
    expect(forkTemplate([template("fork", "run --plain")])).toBeUndefined();
    // Reading `$RESUME_AT` without declaring it is not fork support — the
    // launcher shell would not define the variable at all.
    expect(forkTemplate([template("t", 'run "$RESUME_AT"')])).toBeUndefined();
    expect(templateDeclares(FORK, "RESUME_AT")).toBe(true);
  });

  test("without a prefill the first plain (non-fork) recipe is chosen", () => {
    expect(initialTemplate([PLAIN, FORK], null)?.name).toBe("default");
    // Config order must not decide it: "+ 新規" asked for a new session, so a
    // fork recipe listed first is skipped rather than opened (kawaz r119 m1).
    expect(initialTemplate([FORK, PLAIN], null)?.name).toBe("default");
    expect(plainTemplate([FORK, PLAIN])?.name).toBe("default");
  });

  // Neither kind is guaranteed to exist in a config; each falls back to the
  // first recipe rather than leaving the form with no template at all.
  test("a config with only fork recipes still opens on something", () => {
    expect(initialTemplate([FORK], null)?.name).toBe("fork");
    expect(plainTemplate([FORK])).toBeUndefined();
  });

  // Same rule as the fork point, on the resume recipe's own parameter.
  test("picks the first recipe declaring a session id", () => {
    expect(resumeTemplate([PLAIN, RESUME])?.name).toBe("resume");
    expect(resumeTemplate([PLAIN, FORK])).toBeUndefined();
    expect(resumeTemplate([template("t", 'run --resume "$SESSION_ID"')])).toBeUndefined();
  });

  test("a resume prefill opens on the resume recipe whatever the config order", () => {
    expect(templateFromPrefill([PLAIN, RESUME], RESUME_PREFILL)?.name).toBe("resume");
    expect(templateFromPrefill([RESUME, PLAIN], RESUME_PREFILL)?.name).toBe("resume");
    // …and a fork prefill still opens on the fork recipe, not this one.
    expect(templateFromPrefill([RESUME, FORK], FORK_PREFILL)?.name).toBe("fork");
  });

  // A resume recipe needs a session the user picked elsewhere, exactly like a
  // fork recipe needs a fork point, so "+ 新規" skips it too.
  test("「+ 新規」skips a resume recipe listed first", () => {
    expect(initialTemplate([RESUME, PLAIN], null)?.name).toBe("default");
    expect(plainTemplate([RESUME])).toBeUndefined();
  });

  test("with no resume recipe configured the form still opens", () => {
    expect(templateFromPrefill([PLAIN], RESUME_PREFILL)?.name).toBe("default");
  });
});

// URL がフォームの正本になった以上、リンクが名指した値と、テンプレが宣言して
// いる名前の突き合わせはここが受け持つ。
describe("sb.template / sb.<PARAM> の採用規則", () => {
  test("sb.template は宣言から導く規則より優先される", () => {
    // params だけなら fork 側に落ちるところを、名指しで resume に固定する。
    expect(
      initialTemplate([PLAIN, RESUME, FORK], "resume", { SESSION_ID: "sid-1", RESUME_AT: "u-9" })
        ?.name,
    ).toBe("resume");
  });

  // 別 daemon の config を指す URL を貼られた場合。空のフォームを出すより、
  // 手元の config で意味の通る recipe を選ぶ方が復帰できる。
  test("存在しないテンプレ名は無視して、宣言から導いた recipe に落ちる", () => {
    expect(initialTemplate([PLAIN, FORK], "nope", { RESUME_AT: "u-9" })?.name).toBe("fork");
    expect(initialTemplate([PLAIN, FORK], "nope", {})?.name).toBe("default");
  });

  // 手で打った URL や、他所の config 由来の余分な値。見えない入力が起動内容を
  // 決めてしまわないよう、宣言に無い名前は落とす。
  test("テンプレが宣言していない sb.<PARAM> は採用されない", () => {
    const form = initialSessionCreatorForm([PLAIN], null, {
      CWD: "/repos/app",
      NOT_DECLARED: "x",
      SESSION_ID: "sid-1",
    });
    expect(form.params).not.toHaveProperty("NOT_DECLARED");
    expect(form.params).not.toHaveProperty("SESSION_ID");
    expect(form.params.CWD).toBe("/repos/app");
  });

  // URL が明示した値が、live state から補った値より強い (リンクは意図表明)。
  test("sb.<PARAM> は live state 由来の既定値に勝つ", () => {
    const form = initialSessionCreatorForm(
      [PLAIN, FORK],
      null,
      { SESSION_ID: "sid-1", RESUME_AT: "u-9", CWD: "/from/url" },
      { CWD: "/from/live", MODEL: "opus" },
    );
    // URL が言っていない MODEL だけが live state で埋まる。
    expect(form.params).toMatchObject({ CWD: "/from/url", MODEL: "opus" });
  });
});

describe("selectSessionCreatorTemplate", () => {
  // The command belongs to the recipe, so it follows the switch. Parameters
  // restart from the new declaration except where the user had moved a value
  // away from the old recipe's default.
  test("switching a template replaces the command and keeps the user's edits", () => {
    const start = formFromPrefill([PLAIN, FORK], FORK_PREFILL);
    const edited = {
      ...start,
      params: { ...start.params, CWD: "/repo", MODEL: "opus" },
    };
    const switched = selectSessionCreatorTemplate(edited, [PLAIN, FORK], "default");
    expect(switched).toMatchObject({ template: "default", command: "run-launch" });
    expect(switched.params).toEqual({
      CWD: "/repo",
      MODEL: "opus",
      // Untouched in the fork recipe, so the plain recipe's own default wins.
      EFFORT: "medium",
      PROMPT: "hello",
    });
    // The fork values have no home in the plain recipe and are dropped.
    expect(switched.params).not.toHaveProperty("SESSION_ID");
  });

  test("an untouched value takes the new recipe's default", () => {
    const a = template("a", "cmd-a", { CWD: "", PROMPT: "from-a" });
    const b = template("b", "cmd-b", { CWD: "", PROMPT: "from-b" });
    const start = initialSessionCreatorForm([a, b]);
    expect(selectSessionCreatorTemplate(start, [a, b], "b").params.PROMPT).toBe("from-b");
  });

  test("an unknown name leaves the form untouched", () => {
    const start = initialSessionCreatorForm([PLAIN]);
    expect(selectSessionCreatorTemplate(start, [PLAIN], "nope")).toBe(start);
  });

  // kawaz r259 m43: both recipes take the session under one name, so
  // reconsidering resume ↔ fork for the same session costs nothing — the
  // ordinary same-name rule carries it, with no notion of aliases anywhere.
  test("the session id follows a resume → fork switch", () => {
    const start = formFromPrefill([RESUME, FORK], RESUME_PREFILL);
    const switched = selectSessionCreatorTemplate(start, [RESUME, FORK], "fork");
    expect(switched.params.SESSION_ID).toBe("sid-1");
    // The fork point is not part of what the resume recipe knew, so it stays
    // at the fork recipe's own default rather than being invented.
    expect(switched.params.RESUME_AT).toBe("");
  });

  test("and back again, so the switch is not a one-way trip", () => {
    const start = formFromPrefill([RESUME, FORK], FORK_PREFILL);
    const switched = selectSessionCreatorTemplate(start, [RESUME, FORK], "resume");
    expect(switched.params.SESSION_ID).toBe("sid-1");
    // Nowhere to branch from in the resume recipe, and the value does not
    // leak into some other field on the way.
    expect(switched.params).not.toHaveProperty("RESUME_AT");
  });

  test("unrelated parameters carry across by their own name too", () => {
    const start = formFromPrefill([RESUME, FORK], RESUME_PREFILL);
    const edited = { ...start, params: { ...start.params, PROMPT: "typed" } };
    const switched = selectSessionCreatorTemplate(edited, [RESUME, FORK], "fork");
    expect(switched.params.PROMPT).toBe("typed");
    expect(switched.params.MODEL).toBe("fable");
  });
});

// 呼び出し元が組むリンクそのもの。fork / resume の違いは `sb.*` の中身だけで、
// 受け取る側 (initialTemplate) はその中身から recipe を決める。
describe("prefillSidebarState", () => {
  test("fork は fork 地点ごとリンクに乗る", () => {
    expect(prefillSidebarState({ kind: "fork", sessionId: "sid-1", resumeAt: "u-9" })).toEqual({
      panel: "session-creator",
      template: null,
      search: null,
      params: { SESSION_ID: "sid-1", RESUME_AT: "u-9" },
    });
  });

  // 前回稼働中の行は切断済みで live state から何も読めないので、行が持って
  // いる cwd/model/effort/title を全部リンクに載せる。fork 地点だけは行が
  // 知らないので空のまま (= フォームで貼れる)。
  test("前回稼働中の ⑂ は行の持ち物を全部リンクに載せる", () => {
    expect(
      prefillSidebarState({
        kind: "fork",
        sessionId: "sid-1",
        resumeAt: "",
        cwd: "/repos/app",
        model: "claude-opus-5[1m]",
        effort: "high",
        title: "案件メモ",
      }).params,
    ).toEqual({
      CWD: "/repos/app",
      MODEL: "opus",
      EFFORT: "high",
      TITLE: "案件メモ",
      RESUME_AT: "",
      SESSION_ID: "sid-1",
    });
  });

  // fork 地点が無い = resume の recipe が選ばれる側。
  test("resume は fork 地点を載せない", () => {
    const params = prefillSidebarState({
      kind: "resume",
      cwd: "/repos/app",
      sessionId: "sid-1",
    }).params;
    expect(params).not.toHaveProperty("RESUME_AT");
    expect(params).toEqual({ CWD: "/repos/app", SESSION_ID: "sid-1" });
  });

  // 空の cwd / title はリンクに載せない: テンプレの宣言済み既定値を残す。
  test("空の cwd / title は載せない", () => {
    expect(
      prefillSidebarState({ kind: "resume", cwd: "  ", sessionId: "sid-1", title: "  " }).params,
    ).toEqual({ SESSION_ID: "sid-1" });
  });
});

describe("SESSION_CREATOR_MODELS / SESSION_CREATOR_EFFORTS", () => {
  // DR-0018 §2.1's fixed dropdown options — order matches the DR's listing,
  // which the form renders as-is (no client-side sort).
  test("model list matches the DR-0018 §2.1 spec, in order", () => {
    expect(SESSION_CREATOR_MODELS).toEqual([
      "sonnet",
      "opus",
      "fable",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
    ]);
  });

  // The effort list is the CLI's own, verbatim: `claude --effort` answers an
  // unrecognized level with a stderr warning and its default effort, so an
  // option the CLI does not know silently drops the user's choice.
  test("effort list matches what `claude --effort` accepts, in order", () => {
    expect(SESSION_CREATOR_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

const DEFAULT_COMMAND = PLAIN.command;

function form(overrides: Partial<SessionCreatorForm> = {}): SessionCreatorForm {
  return {
    template: PLAIN.name,
    command: DEFAULT_COMMAND,
    ...overrides,
    params: {
      CWD: "/repo",
      MODEL: "fable",
      EFFORT: "medium",
      PROMPT: "hi",
      ...overrides.params,
    },
  };
}

describe("sessionCreatorFormValid", () => {
  test("valid once cwd is non-blank", () => {
    expect(sessionCreatorFormValid(form())).toBe(true);
    expect(sessionCreatorCwd(form())).toBe("/repo");
  });

  test("invalid with an empty cwd", () => {
    expect(sessionCreatorFormValid(form({ params: { CWD: "" } }))).toBe(false);
  });

  test("invalid with a whitespace-only cwd", () => {
    expect(sessionCreatorFormValid(form({ params: { CWD: "   " } }))).toBe(false);
  });

  // Other parameters are deliberately not part of the gate — an empty prompt is
  // still a launchable `claude` invocation (see session-creator.ts).
  test("valid with an empty prompt, as long as cwd is set", () => {
    expect(sessionCreatorFormValid(form({ params: { PROMPT: "" } }))).toBe(true);
  });
});

// issue 2026-07-17-session-creator-cwd-picker-unify: pure mode-transition
// helpers for CwdPicker's editing/confirmed toggle.
describe("initialCwdPickerMode", () => {
  test("editing when cwd is empty", () => {
    expect(initialCwdPickerMode("")).toBe("editing");
  });

  test("editing when cwd is whitespace-only", () => {
    expect(initialCwdPickerMode("   ")).toBe("editing");
  });

  test("confirmed when a cwd is already set (fork inheritance, declared default)", () => {
    expect(initialCwdPickerMode("/repo")).toBe("confirmed");
  });
});

describe("commitCwdInput", () => {
  test("null on an empty value — an empty Enter press is a no-op", () => {
    expect(commitCwdInput("")).toBeNull();
  });

  test("null on a whitespace-only value", () => {
    expect(commitCwdInput("   ")).toBeNull();
  });

  test("trims and confirms a directly-typed path", () => {
    expect(commitCwdInput("  /repo/deep/path  ")).toEqual({
      cwd: "/repo/deep/path",
      mode: "confirmed",
    });
  });
});

describe("buildSessionLaunchRequest", () => {
  test("null when the form isn't launchable (empty cwd)", () => {
    expect(buildSessionLaunchRequest(form({ params: { CWD: "" } }), [PLAIN])).toBeNull();
  });

  // CWD leaves as the request's own field (the daemon containment-checks it and
  // spawns there); every other parameter travels in `params`, untouched.
  test("trims cwd out into its own field and carries the rest as params", () => {
    expect(
      buildSessionLaunchRequest(
        form({
          params: { CWD: "  /repo/ws  ", MODEL: "gpt-5.6-sol", EFFORT: "high", PROMPT: "go" },
        }),
        [PLAIN],
      ),
    ).toEqual({
      cwd: "/repo/ws",
      params: { MODEL: "gpt-5.6-sol", EFFORT: "high", PROMPT: "go" },
      template: "default",
    });
  });

  test("values are passed through verbatim, including leading/trailing whitespace", () => {
    const req = buildSessionLaunchRequest(form({ params: { PROMPT: "  keep spacing  " } }), [
      PLAIN,
    ]);
    expect(req?.params.PROMPT).toBe("  keep spacing  ");
  });

  // No-edit case: command unchanged from the daemon-configured template, so no
  // `command` field rides along and the daemon runs its own recipe.
  test("omits command when it matches the daemon default verbatim", () => {
    const req = buildSessionLaunchRequest(form({ command: DEFAULT_COMMAND }), [PLAIN]);
    expect(req).not.toHaveProperty("command");
  });

  // Any user edit is sent as-is. The daemon rejects an empty override with
  // invalid_args, so we deliberately pass through empty/whitespace-only
  // strings rather than falling back to the config value.
  test("sends command override when it differs from the default, verbatim", () => {
    expect(buildSessionLaunchRequest(form({ command: "custom --run" }), [PLAIN])).toEqual({
      cwd: "/repo",
      params: { MODEL: "fable", EFFORT: "medium", PROMPT: "hi" },
      template: "default",
      command: "custom --run",
    });
  });

  test("empty command is forwarded (daemon rejects with invalid_args)", () => {
    const req = buildSessionLaunchRequest(form({ command: "" }), [PLAIN]);
    expect(req).toMatchObject({ command: "" });
  });

  // Whitespace-only difference still counts as an edit — trimming would hide
  // an intentional trailing newline the user added.
  test("whitespace-only difference from the default is treated as an edit", () => {
    const req = buildSessionLaunchRequest(form({ command: `${DEFAULT_COMMAND}\n` }), [PLAIN]);
    expect(req?.command).toBe(`${DEFAULT_COMMAND}\n`);
  });

  test("carries the fork values as ordinary params", () => {
    const req = buildSessionLaunchRequest(
      form({
        template: "fork",
        command: FORK.command,
        params: { SESSION_ID: "s-1", RESUME_AT: "u-1" },
      }),
      [PLAIN, FORK],
    );
    expect(req).toMatchObject({ template: "fork" });
    expect(req?.params).toMatchObject({ SESSION_ID: "s-1", RESUME_AT: "u-1" });
    expect(buildSessionLaunchRequest(form(), [PLAIN])?.params).not.toHaveProperty("RESUME_AT");
  });

  // The command baseline is the SELECTED recipe, so an unedited fork command
  // is still a no-override launch even though it differs from the default one.
  test("the no-override comparison follows the selected template", () => {
    const req = buildSessionLaunchRequest(form({ template: "fork", command: FORK.command }), [
      PLAIN,
      FORK,
    ]);
    expect(req).not.toHaveProperty("command");
  });
});
