const cleanupLabels = {
  completed: '清理完成', error: '清理失败', rolled_back: '初始化已回滚',
  rollback_failed: '初始化回滚失败', not_created: '未创建运行资源', pending: '清理尚未完成'
}
const text = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 180) : ''
const errorDetail = error => [text(error?.type || error?.error_type), text(error?.message),
  ...(Array.isArray(error?.errors) ? error.errors.map(text).filter(Boolean) : [])].filter(Boolean).join('：')

// Lifecycle evidence is independent of case quality; never derive success from pass_rate.
export function evaluationRunStatus(report = {}) {
  const isValidation = report.mode === 'validate' || report.status === 'validated'
  const cleanup = report.cleanup?.status
  const cleanupLabel = cleanupLabels[cleanup] || (cleanup ? `清理状态未知：${text(cleanup)}` : '清理未记录')
  const cleanupFailed = ['error', 'rolled_back', 'rollback_failed'].includes(cleanup)
  const cancelled = ['cancelled', 'canceled', 'aborted'].includes(report.status)
    || ['CancelledError', 'AbortError'].includes(report.runtime_error?.type)
  const stopReason = report.budget?.stop_reason
  const reasons = []
  let level = 'success', label = isValidation ? '校验通过' : '运行完成'

  if (cancelled) reasons.push(`运行已取消${errorDetail(report.runtime_error) ? `：${errorDetail(report.runtime_error)}` : ''}`)
  else if (report.runtime_error) reasons.push(`运行异常：${errorDetail(report.runtime_error) || '详细原因未记录'}`)
  else if (report.status === 'error' && !stopReason && !cleanupFailed) reasons.push('运行错误，详细原因未记录')

  if (stopReason) reasons.push(({ model_calls: '模型调用次数达到预算上限', deadline: '已达到模型等待/新任务启动的时间预算' })[stopReason]
    || `预算中断：${text(stopReason) || '原因未记录'}`)
  if (cleanupFailed) reasons.push(`${cleanupLabel}${errorDetail(report.cleanup) ? `：${errorDetail(report.cleanup)}` : ''}`)

  if (cancelled || report.runtime_error || report.status === 'error' || stopReason || cleanupFailed) {
    level = 'danger'
    label = cancelled ? '运行取消' : stopReason && !cleanupFailed && !report.runtime_error ? '预算中断' : '运行失败'
  }

  const missingStatus = !['completed', 'validated', 'error', 'cancelled', 'canceled', 'aborted'].includes(report.status)
  const incompleteCleanup = cleanup !== 'completed' && !cleanupFailed && (!isValidation || cleanup)
  if (missingStatus) reasons.push(report.status ? `运行状态未知：${text(report.status)}` : '运行状态未记录')
  if (incompleteCleanup) reasons.push(cleanupLabel)
  if (level !== 'danger' && (missingStatus || incompleteCleanup)) { level = 'warning'; label = '状态不完整' }
  if (isValidation) reasons.push('本次不调用模型，无质量分数')

  return { level, label, reason: reasons.join('；'), cleanupLabel, isValidation }
}
