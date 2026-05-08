/**
 * Live simulation for demo mode.
 *
 * Makes the demo feel alive by:
 *   - Moving driver GPS every 5 seconds (realistic route from one stop to next)
 *   - Progressing stops automatically (PENDING → ARRIVED → DELIVERED)
 *   - Firing socket events so planner dashboard shows real-time activity
 *   - Occasionally creating a "new failure" or "new return"
 *
 * This is purely cosmetic - makes stakeholders see the system breathing.
 */

// Realistic movement paths between stops (rough polylines)
const PATHS = {
  telaviv: [
    [32.1156, 34.8008], [32.1100, 34.7950], [32.1050, 34.7900],
    [32.0950, 34.7850], [32.0850, 34.7800], [32.0775, 34.7748],
  ],
  jerusalem: [
    [32.0775, 34.7748], [32.0500, 34.8200], [31.9500, 35.0000],
    [31.8500, 35.1500], [31.8100, 35.2000], [31.7816, 35.2179],
  ],
  sharon: [
    [32.0853, 34.7818], [32.1200, 34.8000], [32.1400, 34.8200],
    [32.1500, 34.8300], [32.1624, 34.8442],
  ],
  shfela: [
    [32.0853, 34.7818], [32.0500, 34.7900], [32.0000, 34.7800],
    [31.9800, 34.7900], [31.9730, 34.7925],
  ],
};

let simulationInterval = null;
let pathProgress = { 1: 0, 2: 0 }; // driverId → path index

/**
 * Run one simulation tick.
 */
function tick(io, data) {
  // Move driver 1 along Tel Aviv → Jerusalem route (he's in IN_TRANSIT)
  const path = [...PATHS.telaviv, ...PATHS.jerusalem];
  const p1 = pathProgress[1];
  if (p1 < path.length) {
    const [lat, lng] = path[p1];
    const driver1 = data.driverLocations.find((d) => d.DriverId === 1);
    if (driver1) {
      driver1.Latitude = lat;
      driver1.Longitude = lng;
      driver1.SpeedKmh = 35 + Math.random() * 25;
      driver1.UpdatedAt = new Date().toISOString();
      io.emit('driver:position', {
        driverId: 1, latitude: lat, longitude: lng,
        speedKmh: driver1.SpeedKmh, at: new Date(),
      });
    }
    pathProgress[1] = (p1 + 1) % path.length;
  }

  // Move driver 2 (slowly, warehouse area)
  const p2 = pathProgress[2];
  const driver2 = data.driverLocations.find((d) => d.DriverId === 2);
  if (driver2) {
    driver2.Latitude = 32.0853 + Math.sin(p2 / 10) * 0.005;
    driver2.Longitude = 34.7818 + Math.cos(p2 / 10) * 0.005;
    driver2.UpdatedAt = new Date().toISOString();
    pathProgress[2] = p2 + 1;
  }
}

/**
 * Every 30 seconds, auto-progress a stop to make it feel like something is happening.
 */
function autoProgressStop(io, data) {
  // Find a pending stop and advance it
  const pending = data.stops.find((s) => s.Status === 'PENDING');
  if (!pending) return;

  pending.Status = 'ARRIVED';
  pending.ArrivedAt = new Date().toISOString();
  io.emit('stop:status-changed', { stopId: pending.StopId, status: 'ARRIVED' });
  console.log(`[sim] Stop ${pending.StopId} auto-advanced to ARRIVED`);

  // After 10 sec, mark as delivered
  setTimeout(() => {
    if (pending.Status === 'ARRIVED') {
      pending.Status = 'DELIVERED';
      pending.CompletedAt = new Date().toISOString();
      // Also mark its orders as delivered
      const orders = data.runOrders.filter((o) => o.StopId === pending.StopId);
      for (const o of orders) {
        if (o.Status !== 'DELIVERED') {
          o.Status = 'DELIVERED';
          o.SapDeliveryDocEntry = 9000 + o.RunOrderId;
        }
      }
      io.emit('stop:status-changed', { stopId: pending.StopId, status: 'DELIVERED' });
      io.emit('stop:completed', { stopId: pending.StopId });
      console.log(`[sim] Stop ${pending.StopId} auto-completed`);
    }
  }, 10_000);
}

/**
 * Occasionally fire a "random event" - new failure report, return request, order.
 * Makes the demo feel like a busy operation.
 */
function randomEvent(io, data) {
  const roll = Math.random();

  if (roll < 0.3) {
    // New return request
    const ret = {
      ReturnId: data.returnRequests.length + Math.floor(Math.random() * 1000),
      ReturnNumber: `RET-${new Date().toISOString().slice(0, 10)}-${String(Math.floor(Math.random() * 999)).padStart(3, '0')}`,
      CompanyCode: Math.random() > 0.5 ? 'A' : 'B',
      SapCardName: ['שופרסל', 'מגה', 'רמי לוי', 'ויקטורי'][Math.floor(Math.random() * 4)] + ' ' + ['רמת אביב', 'דיזנגוף', 'תלפיות', 'חיפה'][Math.floor(Math.random() * 4)],
      Status: 'OPEN',
      RequestedDate: new Date().toISOString().slice(0, 10),
      LinesCount: 1 + Math.floor(Math.random() * 5),
    };
    data.returnRequests.unshift(ret);
    io.emit('return:created', ret);
    console.log(`[sim] New return: ${ret.ReturnNumber}`);
  } else if (roll < 0.5) {
    // Picking activity
    io.emit('picking:line-updated', { waveLineId: 1 + Math.floor(Math.random() * 3) });
  } else if (roll < 0.6) {
    // New order delivered
    const order = data.runOrders.find((o) => o.Status === 'PENDING');
    if (order) {
      order.Status = 'DELIVERED';
      order.SapDeliveryDocEntry = 9000 + order.RunOrderId;
      io.emit('order:delivered', order);
      console.log(`[sim] Order delivered: #${order.SapDocNum}`);
    }
  }
}

export function startSimulation(io, data) {
  if (simulationInterval) return;
  console.log('[sim] Live simulation started');

  // GPS movement every 5 sec
  simulationInterval = setInterval(() => tick(io, data), 5000);

  // Auto-progress stops every 45 sec
  setInterval(() => autoProgressStop(io, data), 45_000);

  // Random events every 60 sec
  setInterval(() => randomEvent(io, data), 60_000);
}

export function stopSimulation() {
  if (simulationInterval) {
    clearInterval(simulationInterval);
    simulationInterval = null;
  }
}
