
const redis = require('redis').createClient({
  host: 'redis-14128.c8.us-east-1-2.ec2.cloud.redislabs.com',
  port: 14128,
  password: process.env.REDIS_PASS
})

redis.on('error', err => { console.error('Redis error', err) })

const mapTo4 = {}
const streams = {}

function toJson(str) {
	let resp
	try {
		resp = JSON.parse(str)
	} catch(e) {
		console.error('Redis parse error', e)
	}
	return resp
}

module.exports = {
	map: {
		get: (kitsuId, cb) => {
			if (!kitsuId) cb()
			else {
				if (mapTo4[kitsuId]) cb(mapTo4[kitsuId])
				else
					redis.get('kitsu-a4-' + kitsuId, (err, redisRes) => {
						if (!err && redisRes) {
							const redisSlugs = toJson(redisRes)
							if (redisSlugs) {
								cb(redisSlugs)
								return
							}
						}
						cb()
					})
			}
		},
		set: (kitsuId, data) => {
			if (!mapTo4[kitsuId] || (mapTo4[kitsuId].length > 1 && data.length == 1)) {
				mapTo4[kitsuId] = data
				redis.set('kitsu-a4-' + kitsuId, JSON.stringify(data))
			}
		}
	},
	get: (key, cacheMaxAge, cb) => {

		if (streams[key]) {
			cb({ streams: streams[key], cacheMaxAge })
			return
		}

		redis.get(key, (err, redisRes) => {

			if (!err && redisRes) {
				const redisStreams = toJson(redisRes)
				if (redisStreams) {
					cb({ streams: redisStreams, cacheMaxAge })
					return
				}
			}
			cb()
		})

	},
	set: (key, data) => {
		// cache forever
		streams[key] = data
		redis.set(key, JSON.stringify(data))
	},
	catalog: {
		set: (key, page, data) => {
			if (!key) return
			const redisKey = 'a4-catalog-' + key + (page > 1 ? ('-' + page) : '')
			redis.set(redisKey, JSON.stringify(data))
		},
		get: (key, page, cb) => {
			if (!key) {
				cb()
				return
			}
			const redisKey = 'a4-catalog-' + key + (page > 1 ? ('-' + page) : '')
			redis.get(redisKey, (err, redisRes) => {

				if (!err && redisRes) {
					const redisCatalog = toJson(redisRes)
					if (redisCatalog) {
						cb(redisCatalog)
						return
					}
				}
				cb()
			})
		}
	}
}
