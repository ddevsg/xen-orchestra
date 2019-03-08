import _ from 'intl'
import Component from 'base-component'
import PropTypes from 'prop-types'
import React from 'react'
import SingleLineRow from 'single-line-row'
import StateButton from 'state-button'
import { Col } from 'grid'
import { FormattedDate } from 'react-intl'
import { Select } from 'form'

export default class RestoreMetadataBackupModalBody extends Component {
  static propTypes = {
    backups: PropTypes.array,
  }

  get value() {
    return this.state.backup
  }

  _optionRenderer = ({ timestamp }) => (
    <FormattedDate
      value={new Date(timestamp)}
      month='long'
      day='numeric'
      year='numeric'
      hour='2-digit'
      minute='2-digit'
      second='2-digit'
    />
  )

  render() {
    return (
      <div>
        <SingleLineRow>
          <Col size={6}>{_('chooseBackup')}</Col>
          <Col size={6}>
            <Select
              labelKey='timestamp'
              onChange={this.linkState('backup')}
              optionRenderer={this._optionRenderer}
              options={this.props.backups}
              required
              value={this.state.backup}
              valueKey='id'
            />
          </Col>
        </SingleLineRow>
      </div>
    )
  }
}

export class RestoreMetadataBackupsBulkModalBody extends Component {
  static propTypes = {
    nMetadataBackups: PropTypes.number,
  }

  state = { latest: true }

  get value() {
    return this.state.latest
  }

  render() {
    return (
      <div>
        {_('bulkRestoreMetadataBackupMessage', {
          nMetadataBackups: this.props.nMetadataBackups,
          oldestOrLatest: (
            <StateButton
              disabledLabel={_('oldest')}
              enabledLabel={_('latest')}
              handler={this.toggleState('latest')}
              state={this.state.latest}
            />
          ),
        })}
      </div>
    )
  }
}
