import {
	isSimpleType,
	SimpleType,
	SimpleTypeBooleanLiteral,
	SimpleTypeEnumMember,
	SimpleTypeString,
	SimpleTypeStringLiteral,
	toSimpleType
} from "ts-simple-type";
import { Expression, Type, TypeChecker } from "typescript";
import { HtmlNodeAttrAssignment, HtmlNodeAttrAssignmentKind } from "../../../analyze/types/html-node/html-node-attr-assignment-types.js";
import { HtmlNodeAttrKind } from "../../../analyze/types/html-node/html-node-attr-types.js";
import { RuleModuleContext } from "../../../analyze/types/rule/rule-module-context.js";
import { getDirective } from "../directive/get-directive.js";

const cache = new WeakMap<HtmlNodeAttrAssignment, ExtractedBindingTypes>();

export interface ExtractedBindingTypes {
	typeA: SimpleType;
	typeB: SimpleType;
	// The raw target/source types (ts.Type when available, before SimpleType
	// conversion) so callers can compare with the native TS checker instead.
	rawTypeA: SimpleType | Type | undefined;
	rawTypeB: SimpleType | Type | undefined;
}

export function extractBindingTypes(assignment: HtmlNodeAttrAssignment, context: RuleModuleContext): ExtractedBindingTypes {
	if (cache.has(assignment)) {
		return cache.get(assignment)!;
	}

	const checker = context.program.getTypeChecker();

	// Relax the type we are looking at an expression in javascript files
	//const inJavascriptFile = request.file.fileName.endsWith(".js");
	//const shouldRelaxTypeB = 1 !== 1 && inJavascriptFile && assignment.kind === HtmlNodeAttrAssignmentKind.EXPRESSION;
	const shouldRelaxTypeB = false; // Disable for now while collecting requirements

	// Infer the type of the RHS
	//const typeBInferred = shouldRelaxTypeB ? ({ kind: "ANY" } as SimpleType) : inferTypeFromAssignment(assignment, checker);
	const typeBInferred = inferTypeFromAssignment(assignment, checker);

	// Convert typeB to SimpleType
	let typeB = (() => {
		if (isSimpleType(typeBInferred)) {
			return shouldRelaxTypeB ? relaxType(typeBInferred) : typeBInferred;
		}
		let type: SimpleType;
		try {
			type = toSimpleType(typeBInferred, checker);
		} catch (e) {
			// Converting a deeply recursive / self-referential ts.Type can overflow
			// the stack inside ts-simple-type's lazy resolver. Degrade THIS binding's
			// SimpleType to ANY instead of crashing the whole run. The fallback is
			// scoped to this assignment (cached in the WeakMap below) and is never
			// written into ts-simple-type's shared cache, so unrelated types are
			// unaffected. The raw ts.Type is still kept on `rawTypeB` for the
			// native-checker path.
			if (e instanceof RangeError || e instanceof TypeError) {
				type = { kind: "ANY" };
			} else {
				throw e;
			}
		}
		return shouldRelaxTypeB ? relaxType(type) : type;
	})();

	// Find a corresponding target for this attribute
	const htmlAttrTarget = context.htmlStore.getHtmlAttrTarget(assignment.htmlAttr);
	//if (htmlAttrTarget == null) return [];

	const typeA = htmlAttrTarget == null ? ({ kind: "ANY" } as SimpleType) : htmlAttrTarget.getType();

	// Keep the raw types (ts.Type when available) so the assignability helpers can
	// compare with the native TS checker and skip the SimpleType-based comparison.
	const rawTypeA: SimpleType | Type | undefined = htmlAttrTarget?.declaration?.type?.();
	let rawTypeB: SimpleType | Type | undefined = typeBInferred;

	// Handle directives
	const directive = getDirective(assignment, context);
	const directiveType = directive?.actualType?.();
	if (directiveType != null) {
		typeB = directiveType;
		// typeB now comes from the directive, so the raw expression type no longer
		// describes the value flowing into the binding — drop it.
		rawTypeB = undefined;
	}

	// Cache the result
	const result: ExtractedBindingTypes = { typeA, typeB, rawTypeA, rawTypeB };
	cache.set(assignment, result);

	return result;
}

export function inferTypeFromAssignment(assignment: HtmlNodeAttrAssignment, checker: TypeChecker): SimpleType | Type {
	switch (assignment.kind) {
		case HtmlNodeAttrAssignmentKind.STRING:
			return { kind: "STRING_LITERAL", value: assignment.value } as SimpleTypeStringLiteral;
		case HtmlNodeAttrAssignmentKind.BOOLEAN:
			return { kind: "BOOLEAN_LITERAL", value: true } as SimpleTypeBooleanLiteral;
		case HtmlNodeAttrAssignmentKind.ELEMENT_EXPRESSION:
			return checker.getTypeAtLocation(assignment.expression);
		case HtmlNodeAttrAssignmentKind.EXPRESSION:
			return checker.getTypeAtLocation(assignment.expression);
		case HtmlNodeAttrAssignmentKind.MIXED:
			// Event bindings always looks at the first expression
			// Therefore, return the type of the first expression
			if (assignment.htmlAttr.kind === HtmlNodeAttrKind.EVENT_LISTENER) {
				const expression = assignment.values.find((val): val is Expression => typeof val !== "string");

				if (expression != null) {
					return checker.getTypeAtLocation(expression);
				}
			}

			return { kind: "STRING" } as SimpleTypeString;
	}
}

/**
 * Relax the type so that for example "string literal" become "string" and "function" become "any"
 * This is used for javascript files to provide type checking with Typescript type inferring
 * @param type
 */
export function relaxType(type: SimpleType): SimpleType {
	switch (type.kind) {
		case "INTERSECTION":
		case "UNION":
			return {
				...type,
				types: type.types.map(t => relaxType(t))
			};

		case "ENUM":
			return {
				...type,
				types: type.types.map(t => relaxType(t) as SimpleTypeEnumMember)
			};

		case "ARRAY":
			return {
				...type,
				type: relaxType(type.type)
			};

		case "PROMISE":
			return {
				...type,
				type: relaxType(type.type)
			};

		case "INTERFACE":
		case "OBJECT":
		case "FUNCTION":
		case "CLASS":
			return {
				kind: "ANY"
			};

		case "NUMBER_LITERAL":
			return { kind: "NUMBER" };
		case "STRING_LITERAL":
			return { kind: "STRING" };
		case "BOOLEAN_LITERAL":
			return { kind: "BOOLEAN" };
		case "BIG_INT_LITERAL":
			return { kind: "BIG_INT" };

		case "ENUM_MEMBER":
			return {
				...type,
				type: relaxType(type.type)
			} as SimpleTypeEnumMember;

		case "ALIAS":
			return {
				...type,
				target: relaxType(type.target)
			};

		default:
			return type;
	}
}
