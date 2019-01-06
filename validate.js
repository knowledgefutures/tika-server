const AJV = require("ajv")
const ajv = new AJV()

const { CONFIGURATION_ID } = process.env

module.exports = ajv.compile({
	$schema: "http://json-schema.org/draft-07/schema#",
	type: "array",
	items: {
		type: "object",
		required: ["eventName", "eventSource", "eventTime", "s3"],
		properties: {
			awsRegion: { type: "string" },
			eventName: { pattern: "^ObjectCreated:" },
			eventSource: { const: "aws:s3" },
			eventTime: { type: "string" },
			s3: {
				type: "object",
				required: ["bucket", "configurationId", "object"],
				properties: {
					bucket: {
						type: "object",
						required: ["name"],
						properties: {
							name: { type: "string" },
						},
					},
					configurationId: { const: CONFIGURATION_ID },
					object: {
						type: "object",
						required: ["key", "size"],
						properties: {
							key: { type: "string" },
							size: { type: "integer" },
						},
					},
				},
			},
		},
	},
})
