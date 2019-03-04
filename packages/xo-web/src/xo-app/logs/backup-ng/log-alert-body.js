import _, { FormattedDuration } from 'intl'
import ActionButton from 'action-button'
import decorate from 'apply-decorators'
import Icon from 'icon'
import React from 'react'
import Select from 'form/select'
import Tooltip from 'tooltip'
import { addSubscriptions, formatSize, formatSpeed } from 'utils'
import { countBy, cloneDeep, filter, keyBy, map } from 'lodash'
import { FormattedDate } from 'react-intl'
import { get } from '@xen-orchestra/defined'
import { injectState, provideState } from 'reaclette'
import { runBackupNgJob, subscribeBackupNgLogs, subscribeRemotes } from 'xo'
import { Vm, Sr, Remote, Pool } from 'render-xo-item'

const TASK_STATUS = {
  failure: {
    icon: 'halted',
    label: 'taskFailed',
  },
  skipped: {
    icon: 'skipped',
    label: 'taskSkipped',
  },
  success: {
    icon: 'running',
    label: 'taskSuccess',
  },
  pending: {
    icon: 'busy',
    label: 'taskStarted',
  },
  interrupted: {
    icon: 'halted',
    label: 'taskInterrupted',
  },
}

const TaskStateInfos = ({ status }) => {
  const { icon, label } = TASK_STATUS[status]
  return (
    <Tooltip content={_(label)}>
      <Icon icon={icon} />
    </Tooltip>
  )
}

const TaskDate = ({ label, value }) => (
  <div>
    {_.keyValue(
      _(label),
      <FormattedDate
        value={new Date(value)}
        month='short'
        day='numeric'
        year='numeric'
        hour='2-digit'
        minute='2-digit'
        second='2-digit'
      />
    )}
  </div>
)

const hasTaskFailed = ({ status }) =>
  status !== 'success' && status !== 'pending'

const TaskError = ({ task }) =>
  hasTaskFailed(task) &&
  get(() => task.result.message) !== undefined && (
    <div>
      {_.keyValue(
        _('taskError'),
        <span className='text-danger'>{task.result.message}</span>
      )}
    </div>
  )

const TaskEndAndDuration = ({ task }) =>
  task.end !== undefined && (
    <div>
      <TaskDate label='taskEnd' value={task.end} />
      {_.keyValue(
        _('taskDuration'),
        <FormattedDuration duration={task.end - task.start} />
      )}
    </div>
  )

const Warnings = ({ warnings }) =>
  warnings !== undefined ? (
    <div>
      {warnings.map(({ message, data }) => (
        <div className='text-warning'>
          <Icon icon='alarm' />{' '}
          {message === 'missingVms'
            ? _('logsMissingVms', { vms: data.vms.join(', ') })
            : message}
        </div>
      ))}
    </div>
  ) : null

const UNHEALTHY_VDI_CHAIN_ERROR = 'unhealthy VDI chain'
const UNHEALTHY_VDI_CHAIN_LINK =
  'https://xen-orchestra.com/docs/backup_troubleshooting.html#vdi-chain-protection'

const VmTask = ({ children, restartVmJob, scheduleId, task }) => {
  const id = task.data.id
  const hasFailed = hasTaskFailed(task)

  let error = null
  let message
  if (hasFailed && (message = get(() => task.result.message)) !== undefined) {
    if (message === UNHEALTHY_VDI_CHAIN_ERROR) {
      error = (
        <Tooltip content={_('clickForMoreInformation')}>
          <a
            className='text-info'
            href={UNHEALTHY_VDI_CHAIN_LINK}
            rel='noopener noreferrer'
            target='_blank'
          >
            <Icon icon='info' /> {_('unhealthyVdiChainError')}
          </a>
        </Tooltip>
      )
    } else {
      const [label, className] =
        task.status === 'skipped'
          ? [_('taskReason'), 'text-info']
          : [_('taskError', 'text-danger')]
      error = _.keyValue(label, <span className={className}>{message}</span>)
    }
  }
  return (
    <div>
      <Vm id={id} link newTab /> ({id.slice(4, 8)}){' '}
      <TaskStateInfos status={task.status} />{' '}
      {scheduleId !== undefined && hasFailed && (
        <ActionButton
          handler={restartVmJob}
          icon='run'
          size='small'
          tooltip={_('backupRestartVm')}
          data-vm={id}
        />
      )}
      <Warnings warnings={task.warnings} />
      {children}
      <TaskDate label='taskStart' value={task.start} />
      <TaskEndAndDuration task={task} />
      {error}
      {task.transfer !== undefined && (
        <div>
          {_.keyValue(
            _('taskTransferredDataSize'),
            formatSize(task.transfer.size)
          )}
          <br />
          {_.keyValue(
            _('taskTransferredDataSpeed'),
            formatSpeed(task.transfer.size, task.transfer.duration)
          )}
        </div>
      )}
      {task.merge !== undefined && (
        <div>
          {_.keyValue(_('taskMergedDataSize'), formatSize(task.merge.size))}
          <br />
          {_.keyValue(
            _('taskMergedDataSpeed'),
            formatSpeed(task.merge.size, task.merge.duration)
          )}
        </div>
      )}
      {task.isFull !== undefined &&
        _.keyValue(_('exportType'), task.isFull ? 'full' : 'delta')}
    </div>
  )
}

const PoolTask = ({ task }) => {
  const id = task.data.id
  return (
    <div>
      <Pool id={id} link newTab /> {id.slice(4, 8)}{' '}
      <TaskStateInfos status={task.status} />
      <Warnings warnings={task.warnings} />
      <TaskDate label='taskStart' value={task.start} />
      <TaskEndAndDuration task={task} />
      <TaskError task={task} />
    </div>
  )
}

const XoTask = ({ task }) => (
  <div>
    <Icon icon='menu-xoa' /> XO <TaskStateInfos status={task.status} />
    <Warnings warnings={task.warnings} />
    <TaskDate label='taskStart' value={task.start} />
    <TaskEndAndDuration task={task} />
    <TaskError task={task} />
  </div>
)

const SnapshotTask = ({ task }) => (
  <div>
    <Icon icon='task' /> {_('snapshotVmLabel')}{' '}
    <TaskStateInfos status={task.status} />
    <Warnings warnings={task.warnings} />
    <TaskDate label='taskStart' value={task.start} />
    {task.end !== undefined && <TaskDate label='taskEnd' value={task.end} />}
    <TaskError task={task} />
  </div>
)

const RemoteTask = ({ children, task }) => {
  const id = task.data.id
  return (
    <div>
      <Remote id={id} link newTab /> {id.slice(4, 8)}{' '}
      <TaskStateInfos status={task.status} />
      <Warnings warnings={task.warnings} />
      {children}
      <TaskDate label='taskStart' value={task.start} />
      <TaskEndAndDuration task={task} />
      <TaskError task={task} />
    </div>
  )
}

const SrTask = ({ children, task }) => {
  const id = task.data.id
  return (
    <div>
      <Sr id={id} link newTab /> {id.slice(4, 8)}{' '}
      <TaskStateInfos status={task.status} />
      <Warnings warnings={task.warnings} />
      {children}
      <TaskDate label='taskStart' value={task.start} />
      <TaskEndAndDuration task={task} />
      <TaskError task={task} />
    </div>
  )
}

const TransferOrMergeTask = ({ task }) => {
  const size = get(() => task.result.size)
  return (
    <div>
      <Icon icon='task' /> {task.message}{' '}
      <TaskStateInfos status={task.status} />
      <Warnings warnings={task.warnings} />
      <br />
      <TaskDate label='taskStart' value={task.start} />
      <TaskEndAndDuration task={task} />
      <TaskError task={task} />
      {size > 0 && (
        <div>
          {_.keyValue(_('operationSize'), formatSize(size))}
          <br />
          {_.keyValue(
            _('operationSpeed'),
            formatSpeed(size, task.end - task.start)
          )}
        </div>
      )}
    </div>
  )
}

const TaskLi = ({ className, task, ...props }) => {
  const type = get(() => task.data.type)
  if (type !== undefined) {
    if (type === 'VM') {
      return (
        <li className={className}>
          <VmTask task={task} {...props} />
        </li>
      )
    }

    if (type === 'remote') {
      return (
        <li className={className}>
          <RemoteTask task={task} {...props} />
        </li>
      )
    }

    if (type === 'SR') {
      return (
        <li className={className}>
          <SrTask task={task} {...props} />
        </li>
      )
    }

    if (type === 'pool') {
      return (
        <li className={className}>
          <PoolTask task={task} {...props} />
        </li>
      )
    }

    if (type === 'xo') {
      return (
        <li className={className}>
          <XoTask task={task} {...props} />
        </li>
      )
    }
  }

  if (task.message === 'snapshot') {
    return (
      <li className={className}>
        <SnapshotTask task={task} {...props} />
      </li>
    )
  }

  if (task.message === 'merge' || task.message === 'transfer') {
    return (
      <li className={className}>
        <TransferOrMergeTask task={task} {...props} />
      </li>
    )
  }

  return null
}

export default decorate([
  addSubscriptions(({ id }) => ({
    remotes: cb =>
      subscribeRemotes(remotes => {
        cb(keyBy(remotes, 'id'))
      }),
    log: cb =>
      subscribeBackupNgLogs(logs => {
        cb(logs[id])
      }),
  })),
  provideState({
    initialState: () => ({
      filter: undefined,
    }),
    effects: {
      setFilter: (_, filter) => () => ({
        filter,
      }),
      restartVmJob: (_, { vm }) => async (
        _,
        { log: { scheduleId, jobId } }
      ) => {
        await runBackupNgJob({
          id: jobId,
          vm,
          schedule: scheduleId,
        })
      },
    },
    computed: {
      log: (_, { log }) => {
        if (log === undefined) {
          return {}
        }

        if (log.tasks === undefined) {
          return log
        }

        const newLog = cloneDeep(log)
        newLog.tasks.forEach(task => {
          if (task.tasks === undefined || get(() => task.data.type) !== 'VM') {
            return
          }
          task.tasks.forEach(subTask => {
            const isFull = get(() => subTask.data.isFull)
            if (isFull !== undefined) {
              task.isFull = isFull
              return false
            }
          })
        })

        return newLog
      },
      filteredTaskLogs: ({
        defaultFilter,
        filter: value = defaultFilter,
        log,
      }) =>
        value === 'all'
          ? log.tasks
          : filter(log.tasks, ({ status }) => status === value),
      optionRenderer: ({ countByStatus }) => ({ label, value }) => (
        <span>
          {_(label)} ({countByStatus[value] || 0})
        </span>
      ),
      countByStatus: ({ log }) => ({
        all: get(log.tasks, 'length'),
        ...countBy(log.tasks, 'status'),
      }),
      options: ({ countByStatus }) => [
        { label: 'allTasks', value: 'all' },
        {
          disabled: countByStatus.failure === undefined,
          label: 'taskFailed',
          value: 'failure',
        },
        {
          disabled: countByStatus.pending === undefined,
          label: 'taskStarted',
          value: 'pending',
        },
        {
          disabled: countByStatus.interrupted === undefined,
          label: 'taskInterrupted',
          value: 'interrupted',
        },
        {
          disabled: countByStatus.skipped === undefined,
          label: 'taskSkipped',
          value: 'skipped',
        },
        {
          disabled: countByStatus.success === undefined,
          label: 'taskSuccess',
          value: 'success',
        },
      ],
      defaultFilter: ({ countByStatus }) => {
        if (countByStatus.pending > 0) {
          return 'pending'
        }

        if (countByStatus.failure > 0) {
          return 'failure'
        }

        if (countByStatus.interrupted > 0) {
          return 'interrupted'
        }

        return 'all'
      },
    },
  }),
  injectState,
  ({ remotes, state, effects }) => {
    const { status, result, scheduleId } = state.log
    return (status === 'failure' || status === 'skipped') &&
      result !== undefined ? (
      <span className={status === 'skipped' ? 'text-info' : 'text-danger'}>
        <Icon icon='alarm' /> {result.message}
      </span>
    ) : (
      <div>
        <Select
          labelKey='label'
          onChange={effects.setFilter}
          optionRenderer={state.optionRenderer}
          options={state.options}
          required
          simpleValue
          value={state.filter || state.defaultFilter}
          valueKey='value'
        />
        <Warnings warnings={state.log.warnings} />
        <br />
        <ul className='list-group'>
          {map(state.filteredTaskLogs, taskLog => {
            return (
              <TaskLi
                className='list-group-item'
                key={taskLog.id}
                restartVmJob={effects.restartVmJob}
                scheduleId={scheduleId}
                task={taskLog}
              >
                <ul>
                  {map(taskLog.tasks, subTaskLog => (
                    <TaskLi key={subTaskLog.id} task={subTaskLog}>
                      <ul>
                        {map(subTaskLog.tasks, subSubTaskLog => (
                          <TaskLi task={subSubTaskLog} key={subSubTaskLog.id} />
                        ))}
                      </ul>
                    </TaskLi>
                  ))}
                </ul>
              </TaskLi>
            )
          })}
        </ul>
      </div>
    )
  },
])
