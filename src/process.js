const uuidv4 = require("uuid/v4")
const request = require("request-promise-native")
const IPFS = require("ipfs-http-client")
const Sequelize = require("sequelize")

const assemble = require("./assemble")

const {
	DocumentIdKey,
	OriginalFilenameKey,
	MetaRequest,
	TextRequest,
	IpfsOptions,
	IpldOptions,
} = require("./constants")

const { IPFS_URL, DATABASE_URL } = process.env

const ipfs = IPFS(IPFS_URL)
const { Buffer } = ipfs.types

const sequelize = new Sequelize(DATABASE_URL, {
	logging: false,
	dialectOptions: { ssl: true },
})

const Document = sequelize.import("./models/Documents.js")
const Assertion = sequelize.import("./models/Assertions.js")

const getFileUrl = path => `https://assets.priorartarchive.org/${path}`

module.exports = async function(eventTime, Bucket, Key, data) {
	const { Body, ContentLength, ContentType, Metadata } = data
	const {
		[DocumentIdKey]: documentId,
		[OriginalFilenameKey]: fileName,
	} = Metadata

	const [uploads, organizationId, fileId] = Key.split("/")
	const fileUrl = getFileUrl(Key)

	// These are default properties for the Document in case we have to create one
	const defaults = { id: documentId, organizationId }

	const formData = { [fileName]: Body }

	// Now we have a bunch of stuff to do all at once!

	// The original file and extracted text are added to IPFS as regular files (bytes).
	// The metadata is added to *IPLD* as cbor-encoded JSON. This is more compact but also
	// lets us address paths into the JSON object when we talk about provenance (!!!).

	// `meta` is the actual JSON metadata object parsed from Tika;
	// we return it from a second Promise.all. There's a `cid` intermediate
	// value (an instance of Cidwith a `toString()` method) that we subsequently
	// pin to IPFS (bizarrely, dag.put() doesn't have a {pin: true} option, unlike .add()).
	// The result we get from ipfs.pin.add is the same shape as the results we get from
	// ipfs.add - an array of objects with a string `hash` property [{hash: string}].
	const startTime = new Date() // prov:generatedAtTime for the metadata and transcript
	const [
		[document, created],
		[{ hash: fileHash }],
		[{ hash: textHash, size: textSize }],
		[meta, [{ hash: metaHash }]],
	] = await Promise.all([
		// we need to create a new document, or get the existing one.
		Document.findOrCreate({ where: { id: documentId }, defaults }),
		// we need to add the uploaded file to IPFS
		ipfs.add(Buffer.from(Body), IpfsOptions),
		// we need to post the file to Tika's text extraction service, and add the result to IPFS
		request
			.post({ formData, ...TextRequest })
			.then(text => ipfs.add(Buffer.from(text), IpfsOptions)),
		// we also need to post the file to Tika's metadata service, and add the result to IPFS
		request
			.post({ formData, ...MetaRequest })
			.then(body => JSON.parse(body))
			.then(meta => Promise.all([meta, ipfs.dag.put(meta, IpldOptions)]))
			.then(([meta, cid]) => Promise.all([meta, ipfs.pin.add(cid.toString())])),
	])

	document.update({
		title: meta.title || document.title,
		fileUrl,
		fileName,
		contentType: ContentType,
	})

	const canonized = await assemble({
		eventTime,
		documentId,
		contentSize: ContentLength,
		contentType: ContentType,
		generatedAtTime: startTime.toISOString(),
		fileUrl,
		fileName,
		fileHash,
		textHash,
		textSize: textSize + "B",
		metadata: meta,
		metadataHash: metaHash,
	})

	const [{ hash: cid }] = await ipfs.add(Buffer.from(canonized))

	await Assertion.create({ id: uuidv4(), cid, documentId, organizationId })

	return { key: Key, cid }
}