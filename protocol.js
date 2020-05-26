'use strict'

const log = require('log'),
	fs = require('fs'),
	path = require('path'),
	Protoaion = require('./parsers/proto-aion'),
	enumParser = require('./parsers/enum'),
	defParser = require('./parsers/def')

const aionData = path.dirname(require.resolve('aion-data')),
	defDir = path.join(aionData, 'protocol')

class aionProtocol {
	constructor(shareRevision) {
		this.shareRevision = shareRevision

		const rev = require('aion-data/revisions')[shareRevision]
		if(!rev) throw Error(`Entry for protocol ${shareRevision} not found in aion-data/revisions.json`)

		this.parseRevision(rev)

		try {
			this.packetEnum = enumParser(path.join(aionData, `map/protocol.${this.shareRevision}.map`))
		}
		catch(e) {
			throw Error(`protocol.${this.shareRevision}.map not found`)
		}

		try {
			this.sysmsgEnum = enumParser(path.join(aionData, `map/sysmsg.${this.sysmsgVersion || this.majorPatchVersion}.map`))
		}
		catch(e) {
			throw Error(`sysmsg.${this.sysmsgVersion || this.majorPatchVersion}.map not found`)
		}

		this.proto = new Protoaion(this.gameVersion)
		this.packetsByName = new Map()
		this.packetsById = new Map()
	}

	parseRevision(rev) {
		// (region-)majorPatchVersion(.minorPatchVersion)(/sysmsgVersion)
		const match = /^((.+?)-)?(\d+)(\.(\d+))?(\/(\d+))?$/.exec(rev)

		if(!match) throw Error(`Invalid revision "${rev}"`)

		this.region = match[2]
		this.majorPatchVersion = Number(match[3])
		this.minorPatchVersion = Number(match[5]) || 0
		this.gameVersion = this.majorPatchVersion + this.minorPatchVersion/100
		this.sysmsgVersion = match[7] ? Number(match[7]) : undefined
	}

	compileProto(str) {
		return defParser.compile(defParser.parse(str), this.proto)
	}

	getProto(name, version) {
		// Lookup by name+version
		let compiled = this.packetsByName.get(name)
		if(compiled) compiled = compiled.get(version)

		if(!compiled) {
			compiled = defParser.compile(aionProtocol.defs.get(name).get(def), this.proto)

			// Cache by name+version
			if(!this.packetsByName.has(name)) this.packetsByName.set(name, new Map())
			this.packetsByName.get(name).set(version, compiled)

			// If opcode is mapped: Cache by ID
			const code = this.packetEnum.name.get(name)
			if(code !== undefined) this.packetsById.set(code | version << 16, compiled)
		}

		return compiled
	}

	// name|code, def|version, buf
	read(name, def, buf) {
		try {
			if(def === '*') { // Deprecated: Latest version
				const tempName = typeof name === 'number' ? this.packetEnum.code.get(name) : name
				def = Math.max(...aionProtocol.defs.get(tempName).keys())
			}

			if(typeof def === 'number') { // version
				let compiled

				if(typeof name === 'number') { // code
					const code = name,
						id = code | def << 16

					// Lookup by ID (code+version)
					compiled = this.packetsById.get(id)
					if(!compiled) {
						name = this.packetEnum.code.get(code)

						compiled = defParser.compile(aionProtocol.defs.get(name).get(def), this.proto)

						// Cache by name+version
						if(!this.packetsByName.has(name)) this.packetsByName.set(name, new Map())
						this.packetsByName.get(name).set(def, compiled)

						// Cache by ID
						this.packetsById.set(id, compiled)
					}
				}
				else { // name
					// Lookup by name+version
					compiled = this.packetsByName.get(name)
					if(compiled) compiled = compiled.get(def)

					if(!compiled) {
						compiled = defParser.compile(aionProtocol.defs.get(name).get(def), this.proto)

						// Cache by name+version
						if(!this.packetsByName.has(name)) this.packetsByName.set(name, new Map())
						this.packetsByName.get(name).set(def, compiled)

						// If opcode is mapped: Cache by ID
						const code = this.packetEnum.name.get(name)
						if(code !== undefined) this.packetsById.set(code | def << 16, compiled)
					}
				}

				def = compiled
			}

			return def.read(buf, 7)
		}
		catch(e) {
			const name = this.packetEnum.code.get(buf.readUInt16LE(2))
			e.message = `Error parsing ${name}: ` + e.message
			throw e
		}
	}

	// name|code, def|version, val
	write(name, def, val) {
		const code = typeof name === 'number' ? name : this.packetEnum.name.get(name)

		try {
			if(def === '*') { // Deprecated: Latest version
				const tempName = typeof name === 'number' ? this.packetEnum.code.get(name) : name
				def = Math.max(...aionProtocol.defs.get(tempName).keys())
			}

			if(typeof def === 'number') { // version
				let compiled

				if(code !== undefined) { // Mapped packet
					const id = code | def << 16

					// Lookup by ID (code+version)
					compiled = this.packetsById.get(id)
					if(!compiled) {
						if(name === code) name = this.packetEnum.code.get(code)

						compiled = defParser.compile(aionProtocol.defs.get(name).get(def), this.proto)

						// Cache by name+version
						if(!this.packetsByName.has(name)) this.packetsByName.set(name, new Map())
						this.packetsByName.get(name).set(def, compiled)

						// Cache by ID
						this.packetsById.set(id, compiled)
					}
				}
				else { // Unmapped packet
					// Lookup by name+version
					compiled = this.packetsByName.get(name)
					if(compiled) compiled = compiled.get(def)

					if(!compiled) {
						compiled = defParser.compile(aionProtocol.defs.get(name).get(def), this.proto)

						// Cache by name+version
						if(!this.packetsByName.has(name)) this.packetsByName.set(name, new Map())
						this.packetsByName.get(name).set(def, compiled)
					}
				}

				def = compiled
			}

			const buf = def.write(val, 7)
			// Write header
			buf[0] = buf.length
			buf[1] = buf.length >> 8
			buf[2] = code
			buf[3] = code >> 8
			return buf
		}
		catch(e) {
			if(name === code) name = this.packetEnum.code.get(code)
			e.message = `Error writing ${name}: ` + e.message
			throw e
		}
	}

	// name|code, def|version, val
	length(name, def, val) {
		if(def === '*') { // Deprecated: Latest version
			const tempName = typeof name === 'number' ? this.packetEnum.code.get(name) : name
			def = Math.max(...aionProtocol.defs.get(tempName).keys())
		}

		if(typeof def === 'number') { // version
			const code = typeof name === 'number' ? name : this.packetEnum.name.get(name)

			let compiled

			if(code !== undefined) { // Mapped packet
				const id = code | def << 16

				// Lookup by ID (code+version)
				compiled = this.packetsById.get(id)
				if(!compiled) {
					if(name === code) name = this.packetEnum.code.get(code)

					compiled = defParser.compile(aionProtocol.defs.get(name).get(def), this.proto)

					// Cache by name+version
					if(!this.packetsByName.has(name)) this.packetsByName.set(name, new Map())
					this.packetsByName.get(name).set(def, compiled)

					// Cache by ID
					this.packetsById.set(id, compiled)
				}
			}
			else { // Unmapped packet
				// Lookup by name+version
				compiled = this.packetsByName.get(name)
				if(compiled) compiled = compiled.get(def)

				if(!compiled) {
					compiled = defParser.compile(aionProtocol.defs.get(name).get(def), this.proto)

					// Cache by name+version
					if(!this.packetsByName.has(name)) this.packetsByName.set(name, new Map())
					this.packetsByName.get(name).set(def, compiled)
				}
			}

			def = compiled
		}

		return 7 + def.length(val)
	}

	static loadDefs() {
		this.defs = new Map()

		for(let file of fs.readdirSync(defDir)) {
			const match = /^(.+?)\.(\d+)\.def$/.exec(file)
			if(!match) continue

			const name = match[1],
				version = Number(match[2])

			try {
				this.addDef(name, version, path.join(defDir, file))
			}
			catch(e) {
				log.error(`Error loading ${name}.${version}:`)
				log.error(e)
			}
		}
			// currently unsure how to implement this
		//this.versionCheck = defParser.compile(this.defs.get('C_CHECK_VERSION').get(1), new Protoaion(0))
	}

	static addDef(name, version, file) {
		const parsed = defParser.parse(fs.readFileSync(file, 'utf8'), defDir)

		let versions = this.defs.get(name)
		if(!versions) this.defs.set(name, versions = new Map())
		versions.set(version, parsed)
	}

	static parseVersionCheck(buf) {
		return this.versionCheck.read(buf, 4)
	}
}

aionProtocol.loadDefs()

module.exports = aionProtocol