import { cancelable } from 'promise-toolbox'

const PATH = '/pool/xmldbdump'

export default {
  @cancelable
  exportPoolMetadata($cancelToken) {
    const { pool } = this
    return this.getResource($cancelToken, PATH, {
      task: this.createTask(
        'Pool metadata',
        pool.name_label ?? pool.$master.name_label
      ),
    })
  },

  @cancelable
  importPoolMetadata($cancelToken, buffer, dryRun = true) {
    const { pool } = this
    return this.putResource($cancelToken, buffer, PATH, {
      query: {
        'dry-run': dryRun,
      },
      task: this.createTask(
        'Pool metadata',
        pool.name_label ?? pool.$master.name_label
      ),
    })
  },
}
