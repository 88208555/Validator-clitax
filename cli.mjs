#!/usr/bin/env node
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dispatchOfficialSkillCli, runIntakeHandshake } from './installer.mjs'

const INTAKE_QUESTIONS = [
  { id: 'goal', prompt: 'What is being validated? Describe the deliverable and expected behavior.', required: true, example: '电商运营仪表盘计算工具：输入访客数/订单数/GMV/广告费，输出转化率/客单价/ROAS。' },
  { id: 'riskLevel', prompt: 'Risk level: low, medium, or high?', required: true, example: 'medium' },
  { id: 'complianceReqs', prompt: 'Compliance requirements? (e.g., etl-2, pci-dss, general) Leave empty if none.', required: false, example: 'general' },
  { id: 'targetFiles', prompt: 'Files to validate (or "auto" to scan all).', required: false, example: 'auto' },
]

await dispatchOfficialSkillCli({
  packageRoot: dirname(fileURLToPath(import.meta.url)),
  runCommand: (context) => runIntakeHandshake(context, {
    questions: INTAKE_QUESTIONS,
    outputFile: 'VALIDATOR-REQUIREMENTS.json',
    afterCapabilities(output) {
      const instruction = output.nextStep?.instruction
      if (typeof instruction === 'string' && instruction.trim()) console.log(instruction)
    },
  }),
})
