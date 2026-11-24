import { beforeAll, it } from 'vitest'
import { scratchDir } from '../../tests/scratch.js'

beforeAll(() => { scratchDir('life-setup-'); if (process.env.SCRATCH_LIFE === 'fail') throw new Error('setup broke') })
it('runs once setup is whole', () => {})
