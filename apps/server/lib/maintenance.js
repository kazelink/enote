// 备份恢复会长时间持有 SQLite 写事务（better-sqlite3 是单连接），
// 期间其他写请求要么撞 SQLITE_BUSY 卡住，要么混进同一个事务被一起回滚。
// 用一个显式的维护标志让它们立刻得到 503，而不是超时。
let activeTask = null;

export function beginMaintenance(name) {
    activeTask = name || 'maintenance';
}

export function endMaintenance() {
    activeTask = null;
}

export function maintenanceTask() {
    return activeTask;
}
