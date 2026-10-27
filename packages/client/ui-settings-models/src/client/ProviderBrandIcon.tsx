/** Locally bundled provider marks from Magpie; aliases identify explicit provider routes. */
import type { ReactNode } from 'react'
import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import bedrockColor from './assets/providers/bedrock-color.svg'
import anthropic from './assets/providers/anthropic.svg'
import azureColor from './assets/providers/azure-color.svg'
import baseten from './assets/providers/baseten.svg'
import cerebras from './assets/providers/cerebras.svg'
import cloudflareColor from './assets/providers/cloudflare-color.svg'
import deepseekColor from './assets/providers/deepseek-color.svg'
import fireworksColor from './assets/providers/fireworks-color.svg'
import githubcopilot from './assets/providers/githubcopilot.svg'
import geminiColor from './assets/providers/gemini-color.svg'
import vertexaiColor from './assets/providers/vertexai-color.svg'
import groq from './assets/providers/groq.svg'
import huggingfaceColor from './assets/providers/huggingface-color.svg'
import kimi from './assets/providers/kimi.svg'
import metaColor from './assets/providers/meta-color.svg'
import minimaxColor from './assets/providers/minimax-color.svg'
import mistralColor from './assets/providers/mistral-color.svg'
import moonshot from './assets/providers/moonshot.svg'
import openai from './assets/providers/openai.svg'
import openrouter from './assets/providers/openrouter.svg'
import vercel from './assets/providers/vercel.svg'
import xai from './assets/providers/xai.svg'
import zai from './assets/providers/zai.svg'
import zhipuColor from './assets/providers/zhipu-color.svg'
import xiaomimimo from './assets/providers/xiaomimimo.svg'
import zenmux from './assets/providers/zenmux.svg'
import ollama from './assets/providers/ollama.svg'
import togetherColor from './assets/providers/together-color.svg'
import nvidiaColor from './assets/providers/nvidia-color.svg'
import qwenColor from './assets/providers/qwen-color.svg'
import opencode from './assets/providers/opencode.svg'
import styles from './ProviderConnect.module.css'

const artwork = {
  'bedrock-color': { src: bedrockColor, monochrome: false },
  'anthropic': { src: anthropic, monochrome: true },
  'azure-color': { src: azureColor, monochrome: false },
  'baseten': { src: baseten, monochrome: true },
  'cerebras': { src: cerebras, monochrome: true },
  'cloudflare-color': { src: cloudflareColor, monochrome: false },
  'deepseek-color': { src: deepseekColor, monochrome: false },
  'fireworks-color': { src: fireworksColor, monochrome: false },
  'githubcopilot': { src: githubcopilot, monochrome: true },
  'gemini-color': { src: geminiColor, monochrome: false },
  'vertexai-color': { src: vertexaiColor, monochrome: false },
  'groq': { src: groq, monochrome: true },
  'huggingface-color': { src: huggingfaceColor, monochrome: false },
  'kimi': { src: kimi, monochrome: true },
  'meta-color': { src: metaColor, monochrome: false },
  'minimax-color': { src: minimaxColor, monochrome: false },
  'mistral-color': { src: mistralColor, monochrome: false },
  'moonshot': { src: moonshot, monochrome: true },
  'openai': { src: openai, monochrome: true },
  'openrouter': { src: openrouter, monochrome: true },
  'vercel': { src: vercel, monochrome: true },
  'xai': { src: xai, monochrome: true },
  'zai': { src: zai, monochrome: true },
  'zhipu-color': { src: zhipuColor, monochrome: false },
  'xiaomimimo': { src: xiaomimimo, monochrome: true },
  'zenmux': { src: zenmux, monochrome: true },
  'ollama': { src: ollama, monochrome: true },
  'together-color': { src: togetherColor, monochrome: false },
  'nvidia-color': { src: nvidiaColor, monochrome: false },
  'qwen-color': { src: qwenColor, monochrome: false },
  'opencode': { src: opencode, monochrome: true },
}

const providers: Readonly<Record<string, { src: string; monochrome: boolean }>> = {
  'autoflow-codex': artwork['openai'],
  'amazon-bedrock': artwork['bedrock-color'],
  'anthropic': artwork['anthropic'],
  'azure': artwork['azure-color'],
  'baseten': artwork['baseten'],
  'cerebras': artwork['cerebras'],
  'cloudflare-ai-gateway': artwork['cloudflare-color'],
  'cloudflare-workers-ai': artwork['cloudflare-color'],
  'deepseek': artwork['deepseek-color'],
  'deepseek-official': artwork['deepseek-color'],
  'deepseek-account': artwork['deepseek-color'],
  'fireworks': artwork['fireworks-color'],
  'github-copilot': artwork['githubcopilot'],
  'google': artwork['gemini-color'],
  'google-vertex': artwork['vertexai-color'],
  'groq': artwork['groq'],
  'huggingface': artwork['huggingface-color'],
  'kimi-coding': artwork['kimi'],
  'meta': artwork['meta-color'],
  'minimax': artwork['minimax-color'],
  'minimax-cn': artwork['minimax-color'],
  'mistral': artwork['mistral-color'],
  'moonshotai': artwork['moonshot'],
  'moonshotai-cn': artwork['moonshot'],
  'nvidia': artwork['nvidia-color'],
  'openai': artwork['openai'],
  'openai-codex': artwork['openai'],
  'opencode': artwork['opencode'],
  'opencode-go': artwork['opencode'],
  'openrouter': artwork['openrouter'],
  'qwen-token-plan': artwork['qwen-color'],
  'qwen-token-plan-cn': artwork['qwen-color'],
  'qwen-token-plan-individual': artwork['qwen-color'],
  'together': artwork['together-color'],
  'vercel-ai-gateway': artwork['vercel'],
  'xai': artwork['xai'],
  'xiaomi': artwork['xiaomimimo'],
  'xiaomi-token-plan-ams': artwork['xiaomimimo'],
  'xiaomi-token-plan-cn': artwork['xiaomimimo'],
  'xiaomi-token-plan-sgp': artwork['xiaomimimo'],
  'zai': artwork['zai'],
  'zai-coding-cn': artwork['zai'],
  'zhipu': artwork['zhipu-color'],
  'zenmux': artwork['zenmux'],
  'ollama': artwork['ollama'],
}

/**
 * Render a provider brand mark without fetching external resources.
 * @param props - Exact provider identifier and requested display size.
 * @returns A decorative brand mark, or the existing globe for an unknown route.
 */
export function ProviderBrandIcon({ provider, size = 20 }: { provider: string; size?: number }): ReactNode {
  const asset = providers[provider]
  if (asset === undefined) return <IconGlobeOutlineRegular size={size} />
  // 单色 SVG 通过遮罩继承主题文字色，避免暗色主题中固定黑色图标消失。
  return asset.monochrome
    ? <span aria-hidden="true" className={styles['brandMask']}
      style={{ width: size, height: size, maskImage: `url("${asset.src}")`, WebkitMaskImage: `url("${asset.src}")` }} />
    : <img src={asset.src} className={styles['brandImage']} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
}
