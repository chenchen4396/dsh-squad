import type { Context } from '@deepseek-ai/cordis'
import type { SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'

export async function registerScopedSkillProvider(
  ctx: Context,
  create: (control: SkillProviderControl) => SkillProvider,
): Promise<void> {
  await ctx.inject(['skills'], injectedCtx => {
    injectedCtx.skills.registerProvider(create)
  })
}
