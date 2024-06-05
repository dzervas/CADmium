import * as cadFunctions from "./cadmium-api"
(window as any).cad = cadFunctions

import {
	workbenchIsStale,
	workbenchIndex,
	workbench,
	project,
	featureIndex,
	wasmProject,
	projectIsStale,
	realizationIsStale,
	wasmRealization,
	realization,
	messageHistory,
} from "./stores"
import {get} from "svelte/store"
import {Vector2, Vector3, type Vector2Like} from "three"
import type {
	Entity,
	ExtrusionHistoryStep,
	HistoryStep,
	MessageHistory,
	PlaneHistoryStep,
	PointHistoryStep,
	SketchHistoryStep,
	WithTarget,
	WorkBench
} from "./types"
import type { Realization as WasmRealization, Primitive, StepData, Workbench, MessageResult } from "cadmium"
import type { Message } from "./cadmium-api"
import { isMessage } from "./typeGuards"
// import { isDevelopment } from "../+layout"

// prettier-ignore
const log = (function () { const context = "[projectUtils.ts]"; const color = "aqua"; return Function.prototype.bind.call(console.log, console, `%c${context}`, `font-weight:bold;color:${color};`) })()

export const CIRCLE_TOLERANCE = 0.05

export function isPoint(feature: HistoryStep): feature is PointHistoryStep {
	return feature.data.type === "Point"
}
export function isPlane(feature: HistoryStep): feature is PlaneHistoryStep {
	return feature.data.type === "Plane"
}
export function isExtrusion(feature: HistoryStep): feature is ExtrusionHistoryStep {
	return feature.data.type === "Extrusion"
}
export function isSketch(feature: HistoryStep): feature is SketchHistoryStep {
	return feature.data.type === "Sketch"
}

export function arraysEqual(a: any[], b: any[]) {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false
	}
	return true
}

export function sendWasmMessage(message: Message): MessageResult {
	let wp = get(wasmProject)
	log("[sendWasmMessage] sending message:", message)
	let result = wp.send_message(message)
	log("[sendWasmMessage] reply:", result)

	messageHistory.update((history: MessageHistory[]) => {
		log("[sendWasmMessage] [messageHistory.update] update:", {message, result})
		return [...history, {message, result}]
	})
	return result
}

export function updateExtrusion(extrusionId: number, sketchId: number, length: number, faceIds: string[]) {
	const message: Message = {
		UpdateExtrusion: {
			workbench_id: get(workbenchIndex),
			sketch_id: sketchId,
			face_ids: faceIds.map(id => +id), // on browser side ids are strings - coerce face ids to numbers here to suit rust
			length,
			offset: 0.0,
			extrusion_name: "Extra",
			direction: "Normal",
			extrusion_id: extrusionId,
		},
	}
	const isValid = checkWasmMessage(message)
	const hasFaceIds = notEmpty(message.UpdateExtrusion.face_ids)
	if (isValid) {
		sendWasmMessage(message)
		workbenchIsStale.set(true)
		if (hasFaceIds) {
			log("[updateExtrusion]", "[checkWasmMessage]", "is valid,", "sending message...", message)
			// sendWasmMessage(message)
		} else log("[updateExtrusion]", "[checkWasmMessage]", "is valid,", "but face_ids is empty,", "NOT sending message:", message)
	} else log("[updateExtrusion]", "[checkWasmMessage]", "is bogus,", "abort message send!", message)

	// sendWasmMessage(message)

	// should this be set stale when not sending the wasm message? todo
	// workbenchIsStale.set(true)
}

export function setSketchPlane(sketchId: number, planeId: number) {
	const message: Message = {
		SetSketchPlane: {
			workbench_id: get(workbenchIndex),
			sketch_id: sketchId,
			plane_id: planeId
		}
	}
	checkWasmMessage(message)
	sendWasmMessage(message)
}

export function newSketchOnPlane() {
	const message: Message = {
		StepAction: {
			name: "",
			data: {
				workbench_id: get(workbenchIndex),
				plane_id: "", // leave it floating at first
			}
		}
	}
	checkWasmMessage(message)
	sendWasmMessage(message)
}

export function newExtrusion() {
	const bench: Workbench = get(workbench)
	// log("[newExtrusion] workbench:", workbench)
	// log("[newExtrusion] bench:", bench)

	let sketchId = ""
	for (let step of bench.history) {
		if (step.data.type === "Sketch") {
			sketchId = step.unique_id
		}
	}
	if (sketchId === "") {
		log("No sketch found in history")
		return
	}

	const message: Message = {
		StepAction: {
			data: {
				workbench_id: get(workbenchIndex),
				sketch_id: sketchId,
				face_ids: [],
				length: 25,
				offset: 0.0,
				extrusion_name: "",
				direction: "Normal",
			},
		}
	}

	// we check for face_ids: [] to contain numbers but we send an empty array
	// todo: maybe change isNewExtrusion? although with the rust api it is possible to send an array of faceids so we ought to check them...
	// probably best to alter isNewExtrusion to allow an empty array or a number[]
	checkWasmMessage(message)
	sendWasmMessage(message)
}

export function deleteEntities(sketchIdx: string, selection: Entity[]) {
	const workbenchIdx = get(workbenchIndex)

	// log("[deleteEntities]", "sketchIdx:", sketchIdx, "selection:", selection, "workbenchIdx:", workbenchIdx, "sketchIdx:", sketchIdx, "selection:", selection)
	const lines = selection.filter(e => e.type === "line")
	const arcs = selection.filter(e => e.type === "arc")
	const circles = selection.filter(e => e.type === "circle")
	// const points = selection.filter((e) => e.type === 'point')

	const lineIds = reduceToInts(
		lines.map(e => e.id),
		(id: any) => console.error(`[deleteEntities] line id is not an int: ${id}`),
	)
	const arcIds = reduceToInts(
		arcs.map(e => e.id),
		(id: any) => console.error(`[deleteEntities] arc id is not an int: ${id}`),
	)
	const circleIds = reduceToInts(
		circles.map(e => e.id),
		(id: any) => console.error(`[deleteEntities] circle id is not an int: ${id}`),
	)

	if (notEmpty(lineIds)) deleteLines(workbenchIdx, sketchIdx, lineIds)
	if (notEmpty(arcIds)) deleteArcs(workbenchIdx, sketchIdx, arcIds)
	if (notEmpty(circleIds)) deleteCircles(workbenchIdx, sketchIdx, circleIds)

	// only refresh the workbench once, after all deletions are done
	workbenchIsStale.set(true)
}

export function addRectangleBetweenPoints(sketchIdx: string, point1: number, point2: number) {
	log("[addRectangleBetweenPoints] sketchIdx, point1, point2", sketchIdx, point1, point2)
	const message: Message = {
		NewRectangleBetweenPoints: {
			workbench_id: get(workbenchIndex),
			sketch_id: sketchIdx,
			start_id: point1,
			end_id: point2
		}
	}
	checkWasmMessage(message)
	sendWasmMessage(message)
}

export function addCircleBetweenPoints(sketchIdx: string, point1: string, point2: string) {
	log("[addCircleBetweenPoints]", "sketchIdx:", sketchIdx, "point1:", point1, "point2", point2)

	const p1Valid = isStringInt(point1, id => console.error("[projectUtils.ts] [addCircleBetweenPoints]", "id is not an int:", id))
	const p2Valid = isStringInt(point2, id => console.error("[projectUtils.ts] [addCircleBetweenPoints]", "id is not an int:", id))

	if (!p1Valid || !p2Valid) return

	const message: Message = {
		NewCircleBetweenPoints: {
			workbench_id: get(workbenchIndex),
			sketch_id: sketchIdx,
			center_id: parseInt(point1, 10),
			edge_id: parseInt(point2, 10)
		}
	}
	checkWasmMessage(message)
	sendWasmMessage(message)
}

export function addLineToSketch(sketchIdx: string, point1: number, point2: number) {
	const message: Message = {
		NewLineOnSketch: {
			workbench_id: get(workbenchIndex),
			sketch_id: sketchIdx,
			start_point_id: point1,
			end_point_id: point2
		}
	}
	checkWasmMessage(message)
	sendWasmMessage(message)
}

export function addPointToSketch(sketchIdx: string, point: Vector2Like, hidden: boolean) {
	log("[addPointToSketch] sketchIdx, point, hidden", sketchIdx, point, hidden)
	const message: Message = {
		NewPointOnSketch2: {
			workbench_id: get(workbenchIndex),
			sketch_id: sketchIdx,
			x: point.x,
			y: point.y,
			hidden: hidden,
		},
	}
	checkWasmMessage(message)
	const reply = sendWasmMessage(message)
	// log("[addPointToSketch sendWasmMessage]", "message:", message, "reply:", reply)

	if (!reply.success) console.error("ERROR [projectUtils.ts addPointToSketch sendWasmMessage]", "message:", message, "reply:", reply)

	workbenchIsStale.set(true)
	return JSON.parse(reply.data).id
}

export function addPrimitiveToSketch(sketchIdx: string, primitive: Primitive): number {
	const message: Message = {
		AddSketchPrimitive: {
			workbench_id: get(workbenchIndex),
			sketch_id: sketchIdx,
			primitive
		}
	}
	checkWasmMessage(message)
	const reply = sendWasmMessage(message)

	if (!reply.success)
		console.error("ERROR [projectUtils.ts addPrimitiveToSketch sendWasmMessage]", "message:", message, "reply:", reply)

	return JSON.parse(reply.data).id
}

export function renameStep(stepIdx: number, newName: string): void {
	log("[renameStep] stepIdx, newName", stepIdx, newName)
	const message: Message = {
		RenameStep: {
			workbench_id: get(workbenchIndex),
			step_id: stepIdx,
			new_name: newName,
		},
	}
	checkWasmMessage(message)
	sendWasmMessage(message)
}

export function renameWorkbench(newName: string): void {
	log("[renameWorkbench] newName", newName)
	const message: Message = {
		RenameWorkbench: {
			workbench_id: get(workbenchIndex),
			new_name: newName,
		},
	}
	checkWasmMessage(message)
	sendWasmMessage(message)
}

export function renameProject(newName: string): void {
	log("[renameProject] newName", newName)
	const message: Message = {
		RenameProject: {
			new_name: newName,
		},
	}
	checkWasmMessage(message)
	sendWasmMessage(message)
}

// If the project ever becomes stale, refresh it. This should be pretty rare.
projectIsStale.subscribe(value => {
	if (value) {
		const wp = get(wasmProject)
		project.set(JSON.parse(wp.to_json()))

		workbenchIndex.set(0)
		workbenchIsStale.set(true)
		projectIsStale.set(false)
		// @ts-ignore
		log("[projectIsStale] Refreshing project", "value:", value, "wasmProject:", wp, "project:", project)
	}
})

// If the workbench ever becomes stale, refresh it. This should be very common.
// Every time you edit any part of the feature history, for example
workbenchIsStale.subscribe(value => {
	if (value) {
		log("[workbenchIsStale] Workbench:", get(workbench))
		const workbenchIdx = get(workbenchIndex)
		const wasmProj = get(wasmProject)
		const workbenchJson = wasmProj.get_workbench(workbenchIdx)
		// TODO: reach inside of project and set its representation
		// of the workbench to the new one that we just got
		workbench.set(workbenchJson)
		workbenchIsStale.set(false)
		// log("Workbench:", get(workbench))
		realizationIsStale.set(true)
	}
})

// If the realization ever becomes stale, refresh it. This should be very common.
// Every time you edit any part of the feature history, for example
realizationIsStale.subscribe(value => {
	if (value) {
		// log("[realizationIsStale] Refreshing realization")

		const wasmProj = get(wasmProject)
		const workbenchIdx = get(workbenchIndex)
		const wasmReal: WasmRealization = wasmProj.get_realization(workbenchIdx, get(featureIndex) + 1)
		wasmRealization.set(wasmReal)
		realization.set(JSON.parse(wasmReal.to_json()))
		// log("[realizationIsStale] New realization:", get(realization))
		// log("[wasmProj]", wasmProj)

		realizationIsStale.set(false)
	}
})

export function getObjectString(solidId: string): string {
	// log("[getObjectString] solidId:", solidId)
	const wasmReal = get(wasmRealization)
	const objString = wasmReal.solid_to_obj(solidId, 0.1)
	return objString
}

export function readFile(e: WithTarget<Event, HTMLInputElement>): void {
	const target = e.target as HTMLInputElement
	const file = target.files![0]
	const reader = new FileReader()
	reader.onload = function (e) {
		// log("[readFile] file contents", e.target?.result)
	}
	reader.readAsText(file)
}

export function arcToPoints(center: Vector2, start: Vector2, end: Vector2, clockwise: boolean = false): Vector2[] {
	// log("[arcToPoints] center, start, end, clockwise", center, start, end, clockwise)
	// see https://math.stackexchange.com/a/4132095/816177
	const tolerance = CIRCLE_TOLERANCE // in meters
	const radius = start.distanceTo(center)
	const k = tolerance / radius
	// more precise but slower to calculate:
	// const n = Math.ceil(Math.PI / Math.acos(1 - k))
	// faster to calculate, at most only overestimates by 1:
	let n = Math.ceil(Math.PI / Math.sqrt(2 * k))
	const segmentAngle = (2 * Math.PI) / n
	const segmentLength = radius * segmentAngle
	if (clockwise) n = -n

	const startAngle = Math.atan2(start.y - center.y, start.x - center.x)

	const lineVertices: Vector2[] = []
	lineVertices.push(start.clone())
	for (let i = 1; i <= Math.abs(n); i++) {
		const theta = ((2 * Math.PI) / n) * i + startAngle
		const xComponent = radius * Math.cos(theta)
		const yComponent = radius * Math.sin(theta)
		const point = new Vector2(xComponent, yComponent).add(center)
		lineVertices.push(point)

		const distanceToEnd = point.distanceTo(end)
		if (distanceToEnd <= segmentLength) {
			lineVertices.push(end.clone())
			break
		}
	}
	return lineVertices
}

export function circleToPoints(centerPoint: Vector2Like, radius: number): Vector2[] {
	// this is 2D function

	// see https://math.stackexchange.com/a/4132095/816177
	const tolerance = CIRCLE_TOLERANCE // in meters
	const k = tolerance / radius
	// more precise but slower to calculate:
	// const n = Math.ceil(Math.PI / Math.acos(1 - k))
	// faster to calculate, at most only overestimates by 1:
	const n = Math.ceil(Math.PI / Math.sqrt(2 * k))

	const lineVertices: Vector2[] = []
	for (let i = 0; i <= n; i++) {
		const theta = ((2 * Math.PI) / n) * i
		const xComponent = radius * Math.cos(theta)
		const yComponent = radius * Math.sin(theta)
		const point = new Vector2(xComponent, yComponent).add(centerPoint)
		lineVertices.push(point)
	}
	return lineVertices
}

export function promoteTo3(points: Vector2[]): Vector3[] {
	const points3: Vector3[] = []
	for (const point of points) {
		points3.push(new Vector3(point.x, point.y, 0))
	}
	return points3
}

export function flatten(points: Vector3[]): number[] {
	const pointsFlat: number[] = []
	for (const point of points) {
		pointsFlat.push(point.x, point.y, point.z)
	}
	return pointsFlat
}

function isStringInt(s: string, errorCallback: {(id: any): void; (arg0: string): void}): boolean {
	if (typeof s !== "string") console.error("[proectUtils.ts] [isStringInt]", s, "is not a string:", typeof s)
	const isInt = !Number.isNaN(parseInt(s, 10))
	if (!isInt) errorCallback(s)
	return isInt
}

function reduceToInts(data: string[], errorCallback: (id: any) => void): number[] {
	function reducer(acc: number[], id: string): number[] {
		return isStringInt(id, errorCallback) ? [...acc, parseInt(id, 10)] : acc
	}
	return data.reduce(reducer, [])
}

function notEmpty(array: unknown[]): boolean {
	return array && Array.isArray(array) && array.length > 0
}

export function checkWasmMessage(message: Message, abort = true, logError = true): boolean {
	const key = Object.keys(message)[0]
	const command = message[key as keyof Message]
	if (!command) {
		console.error("[projectUtils.ts] [checkWasmMessage]", "messageType not found:", key, message)
		return false
	}
	log("[checkWasmMessage]", "checking...", key, message)

	function logOrAbort() {
		const error = `[${key}] message failed typecheck:`
		if (logError) console.error("[projectUtils.ts]", error, message)
		// if (abort && isDevelopment()) throw new Error(`"[projectUtils.ts]" ${error}`)
		return false
	}

	if (!isMessage(command)) {
		logOrAbort()
		return false
	}
	return true
}
