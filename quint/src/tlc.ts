/* ----------------------------------------------------------------------------------
 * Copyright 2025 Informal Systems
 * Licensed under the Apache License, Version 2.0.
 * See LICENSE in the project root for license information.
 * --------------------------------------------------------------------------------- */

/**
 * Interface to TLC model checker
 *
 * @author Yassine Boukhari, 2025
 *
 * @module
 */

import { Either, left, right } from '@sweet-monads/either'
import { spawn } from 'child_process'
import fs, { readFileSync } from 'fs'
import path from 'path'
import os from 'os'
import AdmZip from 'adm-zip'
import { apalacheDistDir } from './config'
import { ErrorMessage } from './ErrorMessage'

// Default JVM configuration for TLC
const JVM_MAX_HEAP = '-Xmx8G'
const JVM_STACK_SIZE = '-Xss515m'
const DEFAULT_WORKERS: number | 'auto' = 'auto'

// Verbosity level at which to show TLC's raw output
const TLC_OUTPUT_VERBOSITY = 3

export interface TlcRuntimeConfig {
  maxHeap?: string
  stackSize?: string
  workers?: number | 'auto'
}

export function loadTlcConfig(configPath: string | undefined): TlcRuntimeConfig {
  if (!configPath) {
    return {}
  }
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch (err: any) {
    console.warn(`Warning: failed to read TLC config: ${err.message}, using defaults`)
    return {}
  }
}

// TLC exit codes (from tlc2.tool.EC)
// See: https://github.com/tlaplus/tlaplus/blob/master/tlatools/org.lamport.tlatools/src/tlc2/tool/EC.java
const TLC_EXIT_SUCCESS = 0
const TLC_EXIT_VIOLATION_MIN = 10 // ExitStatus.VIOLATION_ASSUMPTION
const TLC_EXIT_VIOLATION_MAX = 14 // ExitStatus.VIOLATION_ASSERT

function isViolationExitCode(code: number): boolean {
  return code >= TLC_EXIT_VIOLATION_MIN && code <= TLC_EXIT_VIOLATION_MAX
}

/** `tlc` runs the TLC bundled with Apalache; `tlx` runs the native TLC-compatible checker of that name. */
export type TlcChecker = 'tlc' | 'tlx'

// Modules that Apalache's TLA+ output extends. TLC finds them inside the Apalache JAR, tlx needs them on disk.
const APALACHE_MODULES = ['Apalache.tla', 'Variants.tla']

function extractApalacheModules(jarPath: string, targetDir: string): void {
  const jar = new AdmZip(jarPath)
  for (const name of APALACHE_MODULES) {
    jar.extractEntryTo(`tla2sany/StandardModules/${name}`, targetDir, false, true)
  }
}

export interface TlcConfig {
  checker?: TlcChecker
  tlaCode: string
  moduleName: string
  hasInvariant: boolean
  hasTemporal: boolean
}

export type TlcError = {
  explanation: string
  errors: ErrorMessage[]
  isViolation: boolean
}

export type TlcResult<T> = Either<TlcError, T>

function generateCfg(config: TlcConfig): string {
  let cfg = `INIT q_init\nNEXT q_step\n`

  if (config.hasInvariant) {
    cfg += `INVARIANT q_inv\n`
  }
  if (config.hasTemporal) {
    cfg += `PROPERTY q_temporalProps\n`
  }
  return cfg
}

function findApalacheJar(apalacheVersion: string): Either<string, string> {
  const jarPath = path.join(apalacheDistDir(apalacheVersion), 'apalache', 'lib', 'apalache.jar')
  if (fs.existsSync(jarPath)) {
    return right(jarPath)
  }
  return left(`Apalache JAR not found at ${jarPath}. Run 'quint verify' with Apalache backend first to download it.`)
}

function tlcErr(explanation: string, isViolation: boolean): TlcError {
  return { explanation, errors: [], isViolation }
}

export async function verify(
  config: TlcConfig,
  apalacheVersion: string,
  runtimeConfig: TlcRuntimeConfig = {},
  verbosityLevel: number = 2
): Promise<TlcResult<void>> {
  const jarResult = findApalacheJar(apalacheVersion)
  if (jarResult.isLeft()) {
    return left(tlcErr(jarResult.value, false))
  }
  const jarPath = jarResult.value

  const maxHeap = runtimeConfig.maxHeap ?? JVM_MAX_HEAP
  const stackSize = runtimeConfig.stackSize ?? JVM_STACK_SIZE
  const workers = runtimeConfig.workers ?? DEFAULT_WORKERS

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quint-tlc-'))
  const tlaFile = path.join(tmpDir, `${config.moduleName}.tla`)
  const cfgFile = path.join(tmpDir, `${config.moduleName}.cfg`)

  fs.writeFileSync(tlaFile, config.tlaCode)
  fs.writeFileSync(cfgFile, generateCfg(config))

  const checkerArgs = ['-deadlock', '-workers', String(workers), '-metadir', tmpDir]
  let command: string
  let args: string[]
  if (config.checker === 'tlx') {
    extractApalacheModules(jarPath, tmpDir)
    command = process.env.QUINT_TLX ?? 'tlx'
    args = ['check', tlaFile, ...checkerArgs]
  } else {
    command = 'java'
    args = [maxHeap, stackSize, `-Djava.io.tmpdir=${tmpDir}`, '-cp', jarPath, 'tlc2.TLC', ...checkerArgs, tlaFile]
  }

  return new Promise(resolve => {
    const proc = spawn(command, args)

    proc.stdout.on('data', data => {
      if (verbosityLevel >= TLC_OUTPUT_VERBOSITY) {
        process.stdout.write(data.toString())
      }
    })

    proc.stderr.on('data', data => {
      if (verbosityLevel >= TLC_OUTPUT_VERBOSITY) {
        process.stderr.write(data.toString())
      }
    })

    proc.on('close', code => {
      fs.rmSync(tmpDir, { recursive: true, force: true })

      if (code === TLC_EXIT_SUCCESS) {
        resolve(right(undefined))
      } else if (code !== null && isViolationExitCode(code)) {
        resolve(left(tlcErr('found a counterexample', true)))
      } else {
        resolve(left(tlcErr('TLC error (see output above)', false)))
      }
    })

    proc.on('error', err => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      resolve(left(tlcErr(`Failed to spawn ${command}: ${err.message}`, false)))
    })
  })
}
