#!/usr/bin/env node

import { Command } from 'commander'
import { render } from 'ink'
import React from 'react'
import { CodeOwnersApp } from './components/CodeOwnersApp'

const program = new Command()

program
  .name('codeown')
  .description('Generate CODEOWNERS based on git history analysis')
  .version('0.0.1')

program
  .command('generate')
  .description('Generate CODEOWNERS file based on git history')
  .action(() => {
    render(React.createElement(CodeOwnersApp))
  })

program.parse()