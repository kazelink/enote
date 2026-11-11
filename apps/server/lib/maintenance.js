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
