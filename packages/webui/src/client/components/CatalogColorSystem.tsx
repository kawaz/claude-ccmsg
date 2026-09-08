import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

const HUES = ["gray", "brand", "success", "warn", "error", "info", "self", "user"];
const STEPS = Array.from({ length: 12 }, (_, index) => index + 1);
const INPUTS = [
  "--brand",
  "--neutral-tint",
  "--hue-success",
  "--hue-warn",
  "--hue-error",
  "--hue-info",
  "--hue-self",
  "--hue-user",
];

interface ContrastDef {
  background: string;
  foreground: string;
}

const CONTRASTS: ContrastDef[] = [
  { background: "--gray-1", foreground: "--gray-12" },
  { background: "--gray-1", foreground: "--gray-11" },
  { background: "--gray-3", foreground: "--gray-12" },
  { background: "--gray-3", foreground: "--gray-11" },
  { background: "--brand-9", foreground: "white" },
  ...["success", "warn", "error", "info"].flatMap((status) => [
    { background: `--${status}-3`, foreground: `--fg-${status}` },
    { background: `--${status}-9`, foreground: "white" },
  ]),
];

interface ColorValue {
  token: string;
  value: string;
}

interface ContrastValue extends ContrastDef {
  ratio: number;
}

function resolveColor(root: HTMLElement, token: string): string {
  const probe = document.createElement("span");
  probe.style.color = token === "white" ? "white" : `var(${token})`;
  root.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

function srgbBytes(color: string): [number, number, number] | null {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.fillStyle = "#010203";
  context.fillStyle = color;
  if (context.fillStyle === "#010203") return null;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return [red, green, blue];
}

function luminance(color: string): number | null {
  const bytes = srgbBytes(color);
  if (!bytes) return null;
  const linear = bytes.map((byte) => {
    const channel = byte / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(background: string, foreground: string): number {
  const backgroundLuminance = luminance(background);
  const foregroundLuminance = luminance(foreground);
  if (backgroundLuminance === null || foregroundLuminance === null) return 0;
  const lighter = Math.max(backgroundLuminance, foregroundLuminance);
  const darker = Math.min(backgroundLuminance, foregroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function ColorSystemSection(): ComponentChildren {
  const rootRef = useRef<HTMLDivElement>(null);
  const [colors, setColors] = useState<ColorValue[]>([]);
  const [inputs, setInputs] = useState<ColorValue[]>([]);
  const [contrasts, setContrasts] = useState<ContrastValue[]>([]);

  useEffect(() => {
    const read = () => {
      if (!rootRef.current) return;
      const root = rootRef.current;
      const style = getComputedStyle(root);
      setColors(
        HUES.flatMap((hue) =>
          STEPS.map((step) => {
            const token = `--${hue}-${step}`;
            return { token, value: resolveColor(root, token) };
          }),
        ),
      );
      setInputs(INPUTS.map((token) => ({ token, value: style.getPropertyValue(token).trim() })));
      setContrasts(
        CONTRASTS.map((pair) => {
          const background = resolveColor(root, pair.background);
          const foreground = resolveColor(root, pair.foreground);
          return { ...pair, ratio: contrastRatio(background, foreground) };
        }),
      );
    };
    read();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", read);
    return () => media.removeEventListener("change", read);
  }, []);

  const byToken = new Map(colors.map((color) => [color.token, color.value]));
  return (
    <div ref={rootRef}>
      <div class="catalog-color-scale">
        {HUES.map((hue) => (
          <div class="catalog-color-scale-row" key={hue}>
            <code class="catalog-color-scale-hue">{hue}</code>
            <div class="catalog-color-scale-steps">
              {STEPS.map((step) => {
                const token = `--${hue}-${step}`;
                const value = byToken.get(token) ?? "";
                return (
                  <div class="catalog-color-scale-cell" key={token} title={`${token}: ${value}`}>
                    <span class="catalog-color-scale-chip" style={{ background: `var(${token})` }}>
                      {step}
                    </span>
                    <code class="catalog-color-scale-value">{value}</code>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <h3 class="catalog-subtitle">入力</h3>
      <dl class="catalog-color-inputs">
        {inputs.map(({ token, value }) => (
          <div key={token}>
            <dt>
              <code>{token}</code>
            </dt>
            <dd>
              <code>{value}</code>
            </dd>
          </div>
        ))}
      </dl>
      <h3 class="catalog-subtitle">WCAG 2 コントラスト</h3>
      <table class="catalog-color-table">
        <thead>
          <tr>
            <th>背景</th>
            <th>文字</th>
            <th>比</th>
          </tr>
        </thead>
        <tbody>
          {contrasts.map(({ background, foreground, ratio }) => (
            <tr key={`${background}/${foreground}`}>
              <td>
                <code>{background}</code>
              </td>
              <td>
                <code>{foreground}</code>
              </td>
              <td class={ratio < 4.5 ? "catalog-contrast-warning" : undefined}>
                {ratio.toFixed(2)}:1
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
