// 可编辑导出单入口的测试垫片：生产 view 不再携带 done，
// 测试用 deps.onPipelineDone 订阅后台管线完成信号，拼回旧断言的 { ...view, done }。
export async function startEditableWithDone(exportsLib, source, kind, deps = {}, options = {}) {
  const pipelines = [];
  const view = await exportsLib.startEditableExport(source, kind, {
    ...options,
    deps: { ...deps, onPipelineDone: (done) => pipelines.push(done) },
  });
  return { ...view, done: Promise.all(pipelines) };
}
