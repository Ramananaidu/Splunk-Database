var dgram = require('dgram');
var debug = require('util').debuglog('statsd-client');

/*global console*/

function EphemeralSocket(options) {
    options = options || {};

    this._hostname = options.host || 'localhost';
    this._port = parseInt(options.port, 10) || 8125;
    this._sockettype = options.ipv6 ? 'udp6' : 'udp4';
    this._socketTimeoutMsec = 'socketTimeout' in options ? options.socketTimeout : 1000;

    // Check https://github.com/etsy/statsd/blob/master/docs/metric_types.md#multi-metric-packets for advisable sizes.
    this._maxBufferSize = 'maxBufferSize' in options ? options.maxBufferSize : 1200;

    // Set up re-usable socket
    this._socket = undefined; // Store the socket here
    this._socketUsed = false; // Flag if it has been used
    this._socketTimer = undefined; // Reference to check-timer
    this._buffer = "";
}

EphemeralSocket.prototype.log = function log(/*messages*/) {
    //console.log.apply(null, arguments);
};

/* Dual-use timer.
 *
 * First checks if there is anything in it's buffer that need to be sent. If it
 * is non-empty, it will be flushed. (And thusly, the socket is in use and we
 * stop checking further right away).
 *
 * If there is nothing in the buffer and the socket hasn't been used in the
 * previous interval, close it.
 */
EphemeralSocket.prototype._socketTimeout = function _socketTimeout() {
    debug("close()");
    // Flush the buffer, if it contain anything.
    if (this._buffer.length > 0) {
        this._flushBuffer();
        return;
    }

    // Is it already closed? -- then stop here
    if (!this._socket) {
        return;
    }

    // Has been used? -- reset use-flag and wait some more
    if (this._socketUsed) {
        this._socketUsed = false;
        return;
    }

    // Not used? -- close the socket
    this.close();
};


/*
 * Close the socket, if in use and cancel the interval-check, if running.
 */
EphemeralSocket.prototype.close = function close() {
    debug("close()");
    if (!this._socket) {
        return;
    }

    if (this._buffer.length > 0) {
        this._flushBuffer();
    }

    // Cancel the running timer
    if (this._socketTimer) {
        clearInterval(this._socketTimer);
        this._socketTimer = undefined;
    }

    // Wait a tick or two, so any remaining stats can be sent.
    setTimeout(this.kill.bind(this), 10);
};

/* Kill the socket RIGHT NOW.
 */
EphemeralSocket.prototype.kill = function kill() {
    debug("kill()");
    if (!this._socket) {
        return;
    }

    // Clear the timer and catch any further errors silently
    if (this._socketTimer) {
        clearInterval(this._socketTimer);
        this._socketTimer = undefined;
    }
    this._socket.on('error', function () {});

    this._socket.close();
    this._socket = undefined;
};

EphemeralSocket.prototype._createSocket = function _createSocket(callback) {
    debug("_createSocket()");
    if (this._socket) {
        return callback();
    }

    this._socket = dgram.createSocket(this._sockettype);

    // Listen on 'error'-events, so they don't bubble up to the main
    // application. Try closing the socket for now, forcing it to be re-created
    // later.
    this._socket.once('error', this.kill.bind(this));

    // Call on when the socket is ready.
    this._socket.once('listening', function () {
        return callback();
    });
    this._socket.bind({ port: 0, exclusive: true }, null);

    // Start timer, if we have a positive timeout
    if (this._socketTimeoutMsec > 0 && !this._socketTimer) {
        this._socketTimer = setInterval(this._socketTimeout.bind(this), this._socketTimeoutMsec);
    }
};

/* Buffer management
 */
EphemeralSocket.prototype._enqueue = function _enqueue(data) {
    debug("_enqueue(", data, ")");

    if (!this._socketTimer) {
        this._socketTimer = setInterval(this._socketTimeout.bind(this), this._socketTimeoutMsec);
    }
    // Empty buffer if it's too full
    if (this._buffer.length + data.length > this._maxBufferSize) {
        this._flushBuffer();
    }

    if (this._buffer.length === 0) {
        this._buffer = data;
    } else {
        this._buffer += "\n" + data;
    }
};

EphemeralSocket.prototype._flushBuffer = function _flushBuffer() {
    debug("_flushBuffer() ???", this._buffer);
    this._send(this._buffer);
    this._buffer = "";
};

/* Send data - public interface.
 */
EphemeralSocket.prototype.send = function send(data) {
    debug("send(", data, ")");
    if (this._maxBufferSize === 0) {
        return this._send(data);
    } else {
        this._enqueue(data);
    }
};

/*
 * Send data.
 */
EphemeralSocket.prototype._send = function _send(data) {
    debug("_send(", data, ")");
    // If we don't have a socket, or we have created one but it isn't
    // ready yet, we need to enqueue data to send once the socket is ready.
    var that = this;

    this._createSocket(function () {
        that._socketUsed = true;

        // Create message
        var message = new Buffer(data);

        debug(message.toString());

        that._socket.send(message, 0, message.length, that._port, that._hostname);
    });
};

module.exports = EphemeralSocket;
