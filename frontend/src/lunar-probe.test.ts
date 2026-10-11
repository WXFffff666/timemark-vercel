import { it } from 'vitest'
import { Lunar } from 'lunar-javascript'

it('lunar probe', () => {
  for (const [y, m, d] of [[2026, 12, 25], [2026, 6, 25], [2000, 2, 29]] as const) {
    try {
      // eslint-disable-next-line no-console
      console.log('PROBE', y, m, d, '->', Lunar.fromYmd(y, m, d).getSolar().toYmd())
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('PROBE THROW', y, m, d, (e as Error).message)
    }
  }
})
